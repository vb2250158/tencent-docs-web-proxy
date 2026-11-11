import { DOCS_ORIGIN } from "./transport.mjs";
import { ProxyError } from "./errors.mjs";

/** Decode SSE frames across arbitrary byte boundaries without treating transport closure as a saved file. */
export async function readAiEvents(body, onEvent, limit = 8 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const frame = async (text) => {
    let name = "message";
    const lines = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
    }
    const data = lines.join("\n");
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new ProxyError(
        "AI_INVALID_EVENT",
        "The AI service returned an invalid event. Preserve the conversation before retrying.",
      );
    }
    await onEvent(name, parsed);
  };
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > limit)
      throw new ProxyError(
        "AI_RESPONSE_TOO_LARGE",
        "The AI response exceeded the configured limit.",
      );
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      await frame(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await frame(buffer);
}

/** Tencent Docs' native web AI conversation and action streams. */
export class ToolboxAiClient {
  constructor(transport) {
    this.transport = transport;
  }

  async request(payload, { actions = false, onEvent = () => {} } = {}) {
    const url = new URL(
      actions
        ? "/api/ai/v1/copilot/streamactions"
        : "/v1/ai/copilot/conversations/",
      DOCS_ORIGIN,
    );
    url.searchParams.set("xsrf", this.transport.xsrf);
    let response;
    try {
      response = await this.transport.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10 * 60_000),
        headers: {
          cookie: this.transport.cookie,
          "content-type": "application/json",
          accept: "text/event-stream",
          origin: DOCS_ORIGIN,
          referer: `${DOCS_ORIGIN}/ai`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ProxyError(
        "AI_OUTCOME_UNKNOWN",
        "The AI request did not produce a confirmed response. Reconcile the original conversation before repeating it.",
      );
    }
    if (!response.ok)
      throw new ProxyError(
        "AI_HTTP_ERROR",
        `The AI service returned HTTP ${response.status}.`,
      );
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      let data;
      try {
        data = await response.json();
      } catch {
        throw new ProxyError(
          "AI_INVALID_RESPONSE",
          "The AI endpoint did not return an event stream.",
        );
      }
      const rejection = new ProxyError(
        "AI_REJECTED",
        "The AI service rejected this request. Check authorization, input and credits.",
        {
          status: 422,
          details: {
            upstreamCode: data.retcode ?? data.ret ?? data.code ?? null,
          },
        },
      );
      this.transport.onAuthenticationFailure?.(rejection);
      throw rejection;
    }
    const result = {
      text: "",
      files: [],
      conversationId: null,
      messageId: null,
      statuses: [],
    };
    try {
      await readAiEvents(response.body, async (type, data) => {
        await onEvent(type, data);
        if (type === "error" || data.type === "error")
          throw new ProxyError(
            "AI_REJECTED",
            "The AI service reported a generation error.",
            {
              status: 422,
              details: {
                upstreamCode:
                  data.error?.code ?? data.code ?? data.data?.code ?? null,
              },
            },
          );
        const value = data.data ?? data;
        if (type === "control") {
          const control = value.controlMessage ?? value;
          result.conversationId =
            control.conversationId ?? result.conversationId;
          result.messageId = control.messageId ?? result.messageId;
        }
        if (type === "content") {
          const payload = value.content?.content ? value.content : value;
          const content = payload.content ?? payload;
          if (payload.status === 2 || payload.status === 3)
            throw new ProxyError(
              "AI_INCOMPLETE",
              "The AI generation stopped before a complete output was returned.",
            );
          if (typeof content.text === "string") result.text += content.text;
          if (Array.isArray(content.files?.items))
            result.files.push(...content.files.items);
          if (payload.status !== undefined)
            result.statuses.push(payload.status);
        }
      });
    } catch (error) {
      if (error instanceof ProxyError) {
        this.transport.onAuthenticationFailure?.(error);
        error.details = {
          ...error.details,
          conversationId: result.conversationId,
          messageId: result.messageId,
        };
        throw error;
      }
      throw new ProxyError(
        "AI_OUTCOME_UNKNOWN",
        "The AI stream was interrupted. Preserve this conversation before submitting again.",
        {
          details: {
            conversationId: result.conversationId,
            messageId: result.messageId,
          },
        },
      );
    }
    if (!result.text && !result.files.length)
      throw new ProxyError(
        "AI_EMPTY_RESPONSE",
        "The AI service returned no generated content or output file.",
        {
          details: {
            conversationId: result.conversationId,
            messageId: result.messageId,
          },
        },
      );
    if (result.text && !result.files.length && !result.statuses.includes(1))
      throw new ProxyError(
        "AI_OUTCOME_UNKNOWN",
        "The AI stream ended without confirming generated content completion.",
        {
          details: {
            conversationId: result.conversationId,
            messageId: result.messageId,
          },
        },
      );
    return result;
  }

  generate(category, prompt, { files = [], onEvent } = {}) {
    const action =
      category === "slide"
        ? {
            type: 25,
            genOutline: {
              input: prompt,
              category: "slide",
              genre: "slide_outline",
              topic: prompt,
              slidePageType: 0,
            },
          }
        : {
            type: 16,
            generationDocumentContent: { category, content: prompt },
          };
    return this.request(
      {
        author: { role: "user" },
        content: { text: prompt, userInput: prompt },
        resource: { files, urls: [] },
        action,
      },
      { onEvent },
    );
  }

  create(category, generated, options = {}) {
    return this.request({
      author: { role: "user" },
      conversationId: generated.conversationId,
      parentMessageId: generated.messageId,
      action: {
        type: 26,
        createFile: {
          category,
          fileText: generated.text,
          textType: 1,
          ...(category === "slide"
            ? {
                outlineKey: generated.messageId,
                createSlide: {
                  templateId: options.templateId ?? "29000",
                  isCustom: false,
                  enableImageGeneration: false,
                },
              }
            : {}),
        },
      },
    });
  }

  summarize(fileId) {
    return this.request(
      {
        action_type: 10011,
        action_name: "read_in_depth",
        read_in_depth: { fileId, mode: 7, useCache: true },
      },
      { actions: true },
    );
  }
}
