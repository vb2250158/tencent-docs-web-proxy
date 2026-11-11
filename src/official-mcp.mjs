import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProxyError } from "./errors.mjs";

const execute = promisify(execFile);

/** Read only an explicitly configured Tencent Docs MCP token, without returning it to tool callers. */
async function configuredToken() {
  if (process.env.TENCENT_DOCS_TOKEN) return process.env.TENCENT_DOCS_TOKEN;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execute(
        "reg.exe",
        ["query", "HKCU\\Environment", "/v", "TENCENT_DOCS_TOKEN"],
        { windowsHide: true },
      );
      return (
        stdout
          .split(/\r?\n/)
          .find((line) => line.trim().startsWith("TENCENT_DOCS_TOKEN"))
          ?.trim()
          .replace(/^TENCENT_DOCS_TOKEN\s+REG_\w+\s+/, "") ?? ""
      );
    } catch {
      return "";
    }
  }
  return "";
}

/** Optional official tool integration for capabilities published separately from the web toolbox. */
export class OfficialDocsMcp {
  constructor({ fetchImpl = fetch, tokenProvider = configuredToken } = {}) {
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider;
  }
  async call(name, args) {
    const allowed = new Set([
      "create_slide",
      "slide_progress",
      "ocr.toword",
      "ocr.toexcel",
      "ocr.extract",
      "create_mind_by_markdown",
      "create_flowchart_by_mermaid",
      "scrape_url",
      "scrape_progress",
      "create_smartcanvas_by_mdx",
    ]);
    if (!allowed.has(name))
      throw new ProxyError(
        "MCP_TOOL_REJECTED",
        "This official operation is not used by the toolbox.",
        { status: 400 },
      );
    const token = await this.tokenProvider();
    if (!token)
      throw new ProxyError(
        "MCP_AUTH_REQUIRED",
        "此功能需要本机已配置的腾讯文档官方授权。",
        { status: 401 },
      );
    let httpResponse;
    try {
      httpResponse = await this.fetchImpl("https://docs.qq.com/openapi/mcp", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(180_000),
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
    } catch {
      throw new ProxyError(
        "MCP_REQUEST_INTERRUPTED",
        "腾讯文档连接中断，请沿原任务编号核对结果后继续。",
      );
    }
    if (!httpResponse.ok)
      throw new ProxyError(
        "MCP_HTTP_ERROR",
        `腾讯文档官方接口返回 HTTP ${httpResponse.status}。`,
      );
    const chunks = [];
    let length = 0;
    for await (const chunk of httpResponse.body) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024)
        throw new ProxyError(
          "MCP_RESPONSE_TOO_LARGE",
          "官方工具返回的结果过大。",
        );
      chunks.push(chunk);
    }
    const textBody = Buffer.concat(chunks).toString("utf8");
    let rpc;
    try {
      if (
        httpResponse.headers.get("content-type")?.includes("text/event-stream")
      ) {
        for (const line of textBody.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const value = line.slice(5).trim();
          if (!value || value === "[DONE]") continue;
          const frame = JSON.parse(value);
          if (frame.id !== undefined) {
            rpc = frame;
            break;
          }
        }
      } else rpc = JSON.parse(textBody);
    } catch {
      throw new ProxyError(
        "MCP_INVALID_RESPONSE",
        "官方工具返回了无法解析的响应。",
      );
    }
    if (!rpc?.result || rpc.error)
      throw new ProxyError("MCP_TOOL_FAILED", "官方工具没有返回有效结果。", {
        details: { upstreamCode: rpc?.error?.code ?? null },
      });
    const response = rpc.result;
    if (response.isError)
      throw new ProxyError(
        "MCP_TOOL_FAILED",
        "腾讯文档官方工具返回失败，请核对输入和账号权益。",
      );
    if (response.structuredContent) return response.structuredContent;
    const text = response.content?.find((item) => item.type === "text")?.text;
    try {
      return JSON.parse(text);
    } catch {
      return { text: text ?? "" };
    }
  }

  async close() {
    // The stateless official endpoint has no client session to release.
  }
}
