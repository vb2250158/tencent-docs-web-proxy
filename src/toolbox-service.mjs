import { extname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ArtifactStore } from "./artifacts.mjs";
import { ToolJobStore } from "./tool-jobs.mjs";
import { getTool, listToolCatalog } from "./tool-catalog.mjs";
import {
  CloudConversion,
  tencentTransferUrl,
  driveFileId,
} from "./cloud-conversion.mjs";
import { LocalTools } from "./local-tools.mjs";
import { ToolboxAiClient } from "./ai-client.mjs";
import { OfficialDocsMcp } from "./official-mcp.mjs";
import { ToolboxLimits } from "./tool-limits.mjs";
import { ProxyError, publicError } from "./errors.mjs";

const LOCAL_PDF = new Set([
  "pdf_edit",
  "pdf_extract_page",
  "pdf_page_reflow",
  "pdf_split",
  "pdf_merge",
]);
const LOCAL_IMAGE = new Set([
  "image_to_pdf",
  "image_stitching",
  "image_compress",
]);
const CLOUD = new Set([
  "pdf2word",
  "pdf2excel",
  "pdf2ppt",
  "pdf_compress",
  "file_compress",
  "office_to_pdf",
  "mind_to_doc",
  "mind_to_ppt",
]);

/** Public task projection keeps recovery details and upstream temporary addresses private. */
function publicJob(job) {
  const { fingerprint, operation, ...visible } = job;
  return visible;
}

/** Own the catalogue, durable submissions, local artifacts and current upstream task state. */
export class ToolboxService {
  constructor(client, root) {
    this.client = client;
    this.transport = client.transport;
    this.root = root;
    this.artifacts = new ArtifactStore(root);
    this.jobs = new ToolJobStore(root);
    this.local = new LocalTools(this.artifacts);
    this.cloud = new CloudConversion(this.transport, this.artifacts);
    this.ai = new ToolboxAiClient(this.transport);
    this.official = new OfficialDocsMcp();
    this.limits = new ToolboxLimits(this.transport);
    this.running = new Map();
  }

  catalog() {
    return listToolCatalog();
  }

  async run(toolId, input, requestId) {
    const tool = getTool(toolId);
    const ids = input.artifacts ?? [];
    const options = input.options ?? {};
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string") ||
      !options ||
      typeof options !== "object" ||
      Array.isArray(options)
    )
      throw new ProxyError(
        "INVALID_TOOL_INPUT",
        "Supply artifact IDs and a JSON options object.",
        { status: 400 },
      );
    const artifacts = await Promise.all(
      ids.map((id) => this.artifacts.get(id)),
    );
    if (tool.input === "files" && !artifacts.length)
      throw new ProxyError("FILES_REQUIRED", "Choose the files to process.", {
        status: 400,
      });
    if (LOCAL_PDF.has(toolId) && toolId !== "pdf_merge" && artifacts.length > 1)
      throw new ProxyError(
        "INVALID_TOOL_INPUT",
        "此工具每次处理一个 PDF，请分别提交其他文件。",
        { status: 400 },
      );
    const claim = await this.jobs.claim(requestId, {
      toolId,
      artifacts: ids,
      options,
    });
    if (claim.created) {
      const work = this.execute(claim.job, artifacts)
        .catch(async (error) => {
          const failure = publicError(error);
          await this.jobs.update(claim.job.id, {
            state: [
              "UPSTREAM_REJECTED",
              "AI_REJECTED",
              "INVALID_TOOL_INPUT",
              "FILES_REQUIRED",
            ].includes(failure.code)
              ? "failed"
              : "needs_attention",
            error: failure.toJSON(),
          });
        })
        .finally(() => this.running.delete(claim.job.id));
      this.running.set(claim.job.id, work);
    }
    return publicJob(await this.jobs.get(claim.job.id));
  }

  async execute(job, inputs) {
    const { toolId, options } = job;
    if (
      inputs.length > 1 &&
      !LOCAL_PDF.has(toolId) &&
      !LOCAL_IMAGE.has(toolId)
    ) {
      const children = [];
      for (const [index, input] of inputs.entries()) {
        const child = await this.run(
          toolId,
          { artifacts: [input.id], options },
          `batch-${job.id.slice(0, 48)}-${index}`,
        );
        children.push(child.id);
      }
      return this.jobs.update(job.id, {
        state: "running",
        operation: { kind: "batch", children },
        result: { childJobIds: children },
      });
    }
    if (LOCAL_PDF.has(toolId))
      return this.complete(
        job.id,
        await this.local.pdf(toolId, inputs, options),
      );
    if (LOCAL_IMAGE.has(toolId))
      return this.complete(
        job.id,
        await this.local.images(toolId, inputs, options),
      );
    if (toolId === "pdf_ocr_text" || toolId === "pdf_table_extract") {
      if (toolId === "pdf_ocr_text") {
        try {
          return await this.complete(
            job.id,
            await this.local.extractText(inputs[0]),
          );
        } catch (error) {
          if (error.code !== "OCR_REQUIRED") throw error;
        }
      }
      const images = (await this.local.renderPdf(inputs[0], options)).artifacts;
      return this.imageOcr(
        job,
        images,
        toolId === "pdf_table_extract" ? "xlsx" : "docx",
      );
    }
    if (toolId === "file_to_image") {
      if (extname(inputs[0].name).toLowerCase() === ".pdf")
        return this.complete(
          job.id,
          await this.local.renderPdf(inputs[0], options),
        );
      return this.beginCloud(job, inputs[0], toolId);
    }
    if (CLOUD.has(toolId)) return this.beginCloud(job, inputs[0], toolId);
    if (
      toolId === "av_to_text" ||
      (toolId === "voice_notes" && inputs.length)
    ) {
      const uploaded = await this.cloud.temporaryUpload(inputs[0]);
      const media = await this.client.mediaInfo(uploaded.objectKey);
      await this.jobs.update(job.id, { state: "submitting" });
      const task = await this.client.submit({
        ...uploaded,
        fileName: inputs[0].name,
        language: options.language ?? "16k_zh",
        speakerDiarization: options.speakerDiarization ?? false,
      });
      return this.jobs.update(job.id, {
        state: "running",
        operation: { kind: "transcription", id: task.taskId },
        durationSeconds: media.durationSeconds,
      });
    }
    if (toolId === "image_to_word" || toolId === "image_to_excel")
      return this.imageOcr(
        job,
        inputs,
        toolId === "image_to_word" ? "docx" : "xlsx",
      );
    if (toolId === "markdown_to_mind") {
      const text =
        options.markdown ??
        (inputs[0]
          ? (await this.artifacts.readBuffer(inputs[0].id)).toString("utf8")
          : "");
      if (!text.trim())
        throw new ProxyError(
          "INVALID_TOOL_INPUT",
          "Provide Markdown content or a Markdown file.",
          { status: 400 },
        );
      const result = await this.transport.call("createContent", {
        body: {
          name: options.title ?? "Markdown 思维导图",
          commands_format: 2,
          ext: "mind",
          atext: JSON.stringify({ text }),
          parent_id: options.parentId ?? "",
        },
      });
      const url = result.result?.doc_url ?? result.data?.result?.doc_url;
      if (!url)
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "The mind-map writer returned no document URL.",
        );
      return this.complete(job.id, { documentUrl: this.documentUrl(url) });
    }
    if (
      [
        "ai_create_ppt",
        "ai_create_mindmap",
        "ai_create_flowchart",
        "resume",
      ].includes(toolId)
    )
      return this.generateAi(job);
    if (toolId === "ai_summarize") {
      const documentId = await this.documentId(inputs[0], options);
      const result = await this.ai.summarize(documentId);
      return this.complete(job.id, {
        text: result.text,
        conversationId: result.conversationId,
        messageId: result.messageId,
      });
    }
    if (toolId === "image_to_mindmap") {
      const doc = await this.imageImport(inputs[0], "docx");
      const fileId = `${doc.domainId}$${doc.localPadId}`;
      const summary = await this.ai.request(
        {
          action_type: 10011,
          action_name: "read_in_depth",
          read_in_depth: { fileId, mode: 6, useCache: true },
        },
        { actions: true },
      );
      await this.jobs.update(job.id, {
        state: "saving",
        operation: { kind: "ai-create", category: "mind", generated: summary },
      });
      return this.completeAiFile(job.id, await this.ai.create("mind", summary));
    }
    if (toolId === "sheet_to_form" || toolId === "outline_to_form")
      return this.createForm(job, inputs);
    if (toolId === "resume_beautification" || toolId === "pic_to_resume") {
      const bytes = await this.artifacts.readBuffer(
        inputs[0].id,
        50 * 1024 * 1024,
      );
      const type =
        extname(inputs[0].name).toLowerCase() === ".pdf"
          ? "application/pdf"
          : toolId === "pic_to_resume"
            ? inputs[0].mediaType
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const response = await this.transport.call("resumeImport", {
        body: {
          scene: "create",
          file: {
            fileName: inputs[0].name.toLowerCase(),
            content: `data:${type};base64,${bytes.toString("base64")}`,
          },
        },
      });
      const url = response.url ?? response.result?.url;
      if (!url)
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "简历导入没有返回编辑器地址。",
        );
      const target = new URL(this.documentUrl(url));
      target.searchParams.set("show_layout", "true");
      return this.attention(job.id, {
        reason: "resume_editor",
        message: "导入完成，可在简历编辑器中继续美化。",
        documentUrl: target.href,
      });
    }
    if (toolId === "voice_notes") {
      const space = await this.transport.call("personalSpace", {
        body: { appId: "VcZxSbNpGjDf" },
      });
      const response = await this.transport.call("createDocument", {
        body: {
          create_type: 2,
          doc_type: 8,
          template_id: "oz559496eibf7pfqf4jqupg8qr",
          title: options.title ?? "语音速记",
          folder_id: space.result?.fileParentId ?? "",
        },
      });
      const url = response.doc_url ?? response.result?.doc_url;
      if (!url)
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "The voice-note document was not returned.",
        );
      const target = new URL(this.documentUrl(url));
      target.searchParams.set("rec_action", "3");
      target.searchParams.set("create_from", "voiceNotes");
      target.searchParams.set("from_position", "toolbox");
      return this.attention(job.id, {
        reason: "microphone",
        message: "速记文档已创建，请在腾讯文档中开启麦克风并录音。",
        documentUrl: target.href,
      });
    }
    if (toolId === "translate") {
      let doc;
      try {
        doc = await this.cloud.importDocument(inputs[0]);
      } catch (error) {
        if (error.code !== "UPSTREAM_REJECTED") throw error;
        return this.attention(job.id, {
          reason: "translation_import_rejected",
          upstreamCode: error.details?.upstreamCode,
          documentUrl: getTool(toolId).url,
          message:
            "腾讯文档未完成本次文件导入，请在原生工具箱的智能翻译中上传原文件并继续。",
        });
      }
      const url = new URL(this.documentUrl(doc.url));
      url.searchParams.set("translate_from", "toolbox");
      if (options.sourceLanguage && options.targetLanguage) {
        const languages = await this.translationLanguages();
        if (
          !languages.directions.some(
            (direction) =>
              direction.src === options.sourceLanguage &&
              direction.dst === options.targetLanguage,
          )
        )
          throw new ProxyError(
            "INVALID_TOOL_INPUT",
            "腾讯文档不支持所选翻译方向。",
            { status: 400 },
          );
        url.searchParams.set(
          "translate_language",
          `${options.sourceLanguage}2${options.targetLanguage}`,
        );
      }
      return this.attention(job.id, {
        reason: "translation_editor",
        message: "文档已导入，请在原生翻译面板中选择目标语言并提交。",
        documentUrl: url.href,
      });
    }
    const tool = getTool(toolId);
    if (tool.addonId) {
      let response;
      try {
        response = await this.transport.addonMetadata(tool.addonId);
      } catch (error) {
        return this.attention(job.id, {
          reason: "addon",
          addonId: tool.addonId,
          installed: null,
          documentUrl: tool.url,
          message: "插件信息暂未取得，可在腾讯文档工具箱中打开此工具。",
          metadataError: publicError(error).code,
        });
      }
      const addon = response.data?.addons?.[0];
      const info = addon?.basicInfo;
      return this.attention(job.id, {
        reason: "addon",
        addonId: tool.addonId,
        installed: addon?.installed ?? null,
        authorizationRequired: info?.needAuthorize ?? null,
        provider: info?.vendorName ?? info?.name ?? tool.title,
        providerUrl: info?.vendorSite ?? null,
        documentUrl: tool.url,
        message:
          toolId === "E-Sign_Service"
            ? "在腾讯文档插件中准备合同，由签署人完成签署。"
            : "在腾讯文档工具箱中打开此插件，完成所需授权及编辑。",
      });
    }
    if (toolId === "web_clipper") {
      let target;
      try {
        target = new URL(options.url);
      } catch {
        throw new ProxyError(
          "INVALID_TOOL_INPUT",
          "输入要剪存的公开网页地址。",
          { status: 400 },
        );
      }
      if (
        !["https:", "http:"].includes(target.protocol) ||
        target.username ||
        target.password ||
        !target.hostname.includes(".") ||
        /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(
          target.hostname,
        )
      )
        throw new ProxyError(
          "INVALID_TOOL_INPUT",
          "请提供公开网页的 HTTP 或 HTTPS 地址。",
          { status: 400 },
        );
      const operationId = job.id.slice(0, 24);
      await this.jobs.update(job.id, { state: 'submitting', operation: { kind: 'native-clip', id: operationId } });
      const response = await this.transport.call('clipPage', { body: { url: target.href, operationId, parentId: '' } });
      const result = response.result;
      if (!result?.padId && !result?.needProgress) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', '网页剪存未返回文档或进度信息。');
      const documentUrl = result.docUrl ?? result.url;
      return this.jobs.update(job.id, { state: 'running', operation: { kind: 'native-clip', id: operationId, padId: result.padId, documentUrl } });
    }
    throw new ProxyError("UNKNOWN_TOOL", "The selected tool has no runner.", {
      status: 400,
    });
  }

  async translationLanguages() {
    const response = await this.transport.call("translationLanguages");
    if (
      !Array.isArray(response.result?.languages) ||
      !Array.isArray(response.result?.directions)
    )
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "翻译语言清单暂未取得。",
      );
    return response.result;
  }

  async documentId(input, options) {
    if (typeof options.documentId === "string" && options.documentId)
      return options.documentId;
    if (!input)
      throw new ProxyError(
        "INVALID_TOOL_INPUT",
        "Provide a document ID or input file.",
        { status: 400 },
      );
    const doc = await this.cloud.importDocument(input);
    return `${doc.domainId}$${doc.localPadId}`;
  }

  async beginCloud(job, input, toolId) {
    await this.jobs.update(job.id, { state: "submitting" });
    const operation = await this.cloud.submit(toolId, input, job.options);
    return this.jobs.update(job.id, {
      state: "running",
      operation,
      progress: 0,
    });
  }

  async imageImport(input, extension) {
    const operationId = crypto.randomUUID();
    const body = new FormData();
    body.set(
      "file",
      new Blob([await this.artifacts.readBuffer(input.id, 10 * 1024 * 1024)]),
      input.name,
    );
    for (const [key, value] of Object.entries({
      operation_id: operationId,
      business_type: "5",
      filename: `${operationId}.${extension}`,
      preview: "1",
      folder: "/",
    }))
      body.set(key, value);
    await this.transport.call("importThird", { body });
    return this.cloud.waitImport(operationId);
  }

  async imageOcr(job, inputs, extension) {
    const documents = [];
    for (const input of inputs) {
      const doc = await this.imageImport(input, extension);
      documents.push({
        name: doc.title,
        url: this.documentUrl(doc.url),
        documentId: `${doc.domainId}$${doc.localPadId}`,
      });
    }
    return this.complete(job.id, { documents });
  }

  async generateAi(job) {
    const category = {
      ai_create_ppt: "slide",
      ai_create_mindmap: "mind",
      ai_create_flowchart: "flowchart",
      resume: "resume",
    }[job.toolId];
    const prompt = job.options.prompt;
    if (typeof prompt !== "string" || !prompt.trim())
      throw new ProxyError(
        "INVALID_TOOL_INPUT",
        "Enter the content you want to generate.",
        { status: 400 },
      );
    await this.jobs.update(job.id, { state: "generating" });
    const generated = await this.ai.generate(category, prompt, {
      onEvent: async (type, data) => {
        if (type !== "control") return;
        const control = data.controlMessage ?? data;
        await this.jobs.update(job.id, {
          operation: {
            kind: "ai-generation",
            category,
            conversationId: control.conversationId,
            messageId: control.messageId,
          },
        });
      },
    });
    if (generated.files.length) return this.completeAiFile(job.id, generated);
    await this.jobs.update(job.id, {
      state: "saving",
      operation: { kind: "ai-create", category, generated },
    });
    return this.completeAiFile(
      job.id,
      await this.ai.create(category, generated, job.options),
    );
  }

  async completeAiFile(id, result) {
    const documents = result.files
      .filter((file) => typeof file.url === "string")
      .map((file) => ({
        name: file.name ?? file.title ?? "",
        url: this.documentUrl(file.url),
      }));
    if (!documents.length)
      return this.attention(id, {
        reason: "ai_generated_content",
        text: result.text,
        conversationId: result.conversationId,
        messageId: result.messageId,
        message:
          "AI 已返回内容，尚未取得已保存文档链接，可在原生 AI 界面继续创建文档。",
        documentUrl: "https://docs.qq.com/ai",
      });
    return this.complete(id, {
      documents,
      conversationId: result.conversationId,
      messageId: result.messageId,
    });
  }

  async createForm(job, inputs) {
    const options = job.options;
    let questions = options.questions;
    if (!questions && job.toolId === "sheet_to_form") {
      const id = await this.documentId(inputs[0], options);
      const sheets = await this.transport.call("sheetSubIds", {
        body: { sheet_id: id },
      });
      const list =
        sheets.result?.sub_sheet ??
        sheets.result?.sheets ??
        sheets.result?.sub_ids ??
        sheets.result?.subIds ??
        sheets.result;
      const first = Array.isArray(list) ? list[0] : null;
      const subId =
        options.subId ??
        first?.sub_id ??
        first?.subId ??
        first?.id ??
        (typeof first === "string" ? first : undefined);
      if (!subId)
        return this.attention(job.id, {
          reason: "form_columns",
          sourceDocumentId: id,
          sheets: sheets.result,
          documentUrl: "https://docs.qq.com/open/toolkit/index.html",
          message: "已读取子表信息，请在原生表格转收集表面板中确认列与题型。",
        });
      const data = await this.transport.call("sheetData", {
        body: { sheet_id: id, sub_id: subId },
      });
      const rows = data.result?.rows?.map((row) => row.cells) ?? [];
      questions =
        rows[0]?.map((title, index) =>
          this.formQuestion(
            title,
            rows
              .slice(1)
              .map((row) => row[index])
              .filter((value) => typeof value === "string" && value.trim()),
          ),
        ) ?? [];
    }
    if (!questions && typeof options.outline === "string")
      questions = options.outline
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-#*\d.)、\s]+/, "").trim())
        .filter(Boolean)
        .map((title) => this.formQuestion(title));
    if (!Array.isArray(questions) || !questions.length)
      return this.attention(job.id, {
        reason: "form_questions",
        documentUrl: "https://docs.qq.com/open/toolkit/index.html",
        message:
          "请提供 questions 与 sections，或在原生大纲转收集表中确认题型。",
      });
    const title = options.title ?? "收集表";
    const sections = options.sections ?? [
      { sid: 0, qlist: questions.map((question) => question.id) },
    ];
    const response = await this.transport.call("createForm", {
      body: {
        title,
        text: JSON.stringify({
          formName: title,
          title,
          subtitle: options.subtitle ?? "",
          questions,
          sections,
          isDirty: true,
        }),
        form_type: options.formType ?? 0,
      },
    });
    if (!response.result?.doc_url)
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "The form creator returned no document URL.",
      );
    return this.complete(job.id, {
      documentUrl: this.documentUrl(response.result.doc_url),
    });
  }

  formQuestion(title, choices = []) {
    const now = Date.now();
    const unique = [...new Set(choices)];
    return {
      id: crypto.randomUUID(),
      type: unique.length ? "SELECT" : "SIMPLE",
      title: String(title),
      createTime: now,
      updateTime: now,
      dataType: 1,
      isDirty: false,
      placeholder: "",
      richSubtitle: "",
      subtitle: "",
      validate: [{ type: 1, rules: {}, message: "" }],
      qdata: unique.length
        ? {
            options: unique.map((value) => ({
              id: crypto.randomUUID(),
              title: value,
            })),
          }
        : {},
      toggle: { required: true, showValidate: false },
    };
  }

  documentUrl(value) {
    const url = new URL(value, "https://docs.qq.com");
    if (url.origin !== "https://docs.qq.com" || url.username || url.password)
      throw new ProxyError(
        "UNSAFE_DOCUMENT_URL",
        "The returned document link is outside Tencent Docs.",
      );
    return url.href;
  }

  async complete(id, result) {
    return this.jobs.update(id, { state: "completed", progress: 100, result });
  }
  async attention(id, result) {
    return this.jobs.update(id, { state: "user_action_required", result });
  }

  async status(id) {
    let job = await this.jobs.get(id);
    if (!this.running.has(id)) job = await this.jobs.get(id);
    if (
      job.state === "needs_attention" &&
      job.operation &&
      ["official-slide", "official-scrape", "transcription"].includes(
        job.operation.kind,
      ) &&
      [
        "INTERNAL_ERROR",
        "MCP_REQUEST_INTERRUPTED",
        "MCP_CONNECTION_FAILED",
        "UPSTREAM_NETWORK_ERROR",
      ].includes(job.error?.code)
    ) {
      job = await this.jobs.update(id, { state: "running", error: undefined });
    }
    if (
      !this.running.has(id) &&
      ["preparing", "submitting", "generating", "saving", "rendering"].includes(
        job.state,
      )
    ) {
      return publicJob(
        await this.jobs.update(id, {
          state: "needs_attention",
          error: {
            code: "JOB_OUTCOME_UNKNOWN",
            message: "执行进程已结束，请沿原任务编号核对上游结果后继续。",
          },
        }),
      );
    }
    if (this.running.has(id) || job.state !== "running" || !job.operation)
      return publicJob(job);
    const work = this.refresh(job).finally(() => this.running.delete(id));
    this.running.set(id, work);
    try {
      return publicJob(await work);
    } catch (error) {
      return publicJob(
        await this.jobs.update(id, {
          state: "needs_attention",
          error: publicError(error).toJSON(),
        }),
      );
    }
  }

  async refresh(job) {
    if (job.operation.kind === 'native-clip') {
      const response = await this.transport.call('clipProgress', { body: { operationId: job.operation.id, padId: job.operation.padId } });
      const result = response.result;
      if (result?.status === 'failed') return this.jobs.update(job.id, { state: 'failed', error: { code: 'CLIP_FAILED', message: '腾讯文档未能剪存此网页。' } });
      if (Number(result?.progress) === 100) {
        const address = result.docUrl ?? job.operation.documentUrl;
        if (!address) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', '剪存完成，但尚未取得文档链接。');
        return this.complete(job.id, { documentUrl: this.documentUrl(address) });
      }
      return this.jobs.update(job.id, { progress: Number(result?.progress ?? 0) });
    }

    if (job.operation.kind === "batch") {
      const children = await Promise.all(
        job.operation.children.map((id) => this.status(id)),
      );
      const active = children.some(
        (child) =>
          ![
            "completed",
            "failed",
            "needs_attention",
            "user_action_required",
          ].includes(child.state),
      );
      const result = {
        childJobs: children.map((child) => ({
          id: child.id,
          state: child.state,
          error: child.error,
        })),
        artifacts: children.flatMap((child) => child.result?.artifacts ?? []),
        downloads: children.flatMap(
          (child, index) =>
            child.result?.downloads ??
            (child.result?.downloadUrl
              ? [
                  {
                    url: child.result.downloadUrl,
                    name: `结果文件-${index + 1}`,
                  },
                ]
              : []),
        ),
        documents: children.flatMap(
          (child) =>
            child.result?.documents ??
            (child.result?.documentUrl
              ? [{ url: child.result.documentUrl }]
              : []),
        ),
      };
      if (active)
        return this.jobs.update(job.id, {
          progress: Math.round(
            (children.filter((child) => child.state === "completed").length /
              children.length) *
              100,
          ),
          result,
        });
      return this.jobs.update(job.id, {
        state: children.every((child) => child.state === "completed")
          ? "completed"
          : "needs_attention",
        result,
        progress: 100,
      });
    }
    if (
      job.operation.kind === "official-slide" ||
      job.operation.kind === "official-scrape"
    ) {
      const result = await this.official.call(
        job.operation.kind === "official-slide"
          ? "slide_progress"
          : "scrape_progress",
        job.operation.kind === "official-slide"
          ? { session_id: job.operation.id }
          : { task_id: job.operation.id },
      );
      if (result.error || result.status === "failed")
        return this.jobs.update(job.id, {
          state: "failed",
          error: {
            code: "UPSTREAM_REJECTED",
            message: "腾讯文档任务失败，请检查输入和权益。",
          },
        });
      if (result.status === "not_found")
        return this.jobs.update(job.id, {
          state: "needs_attention",
          error: {
            code: "UPSTREAM_TASK_NOT_FOUND",
            message: "上游没有找到原任务，已保留原编号，请在腾讯文档中核对。",
          },
        });
      const url = result.file_url ?? result.url;
      if (url)
        return this.complete(job.id, { documentUrl: this.documentUrl(url) });
      return this.jobs.update(job.id, {
        progress: Number(result.progress ?? 0),
      });
    }
    if (job.operation.kind === "transcription") {
      const status = await this.client.status(job.operation.id);
      if (status.state === "completed")
        return this.complete(job.id, { documentUrl: status.fileUrl });
      return this.jobs.update(job.id, {
        state: status.state === "failed" ? "failed" : "running",
        progress: status.progress,
      });
    }
    const status = await this.cloud.status(job.operation);
    if (status.state === "failed")
      return this.jobs.update(job.id, {
        state: "failed",
        error: {
          code: "CONVERSION_FAILED",
          message: "腾讯文档转换失败，请核对输入文件。",
        },
      });
    if (status.state === "needs_save") {
      await this.jobs.update(job.id, { state: "saving" });
      const result = await this.cloud.savePdf(job.operation);
      return this.complete(job.id, {
        documentUrl: this.documentUrl(result.tencentDocUrl),
        documentId: result.fileId,
      });
    }
    if (status.state !== "completed")
      return this.jobs.update(job.id, { progress: status.progress });
    const result = status.result;
    const address = result.tencentDocUrl ?? result.downloadUrl ?? result.url;
    if (job.operation.renderImages && address) {
      await this.jobs.update(job.id, { state: "rendering" });
      const authorized = await this.transport.call("downloadFile", {
        body: { file_id: driveFileId(address) },
      });
      const rawUrl =
        authorized.result?.downloadUrl ?? authorized.result?.download_url;
      if (!rawUrl)
        throw new ProxyError(
          "DOWNLOAD_FAILED",
          "腾讯文档没有返回原始 PDF 下载地址。",
        );
      const url = tencentTransferUrl(rawUrl);
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new ProxyError(
          "DOWNLOAD_FAILED",
          "The converted PDF could not be downloaded.",
        );
      const artifact = await this.artifacts.put(
        response.body,
        "converted.pdf",
        { maxBytes: 100 * 1024 * 1024, mediaType: "application/pdf" },
      );
      return this.complete(
        job.id,
        await this.local.renderPdf(artifact, job.options),
      );
    }
    const isDocument = (value) =>
      typeof value === "string" &&
      (value.startsWith("//docs.qq.com/") ||
        value.startsWith("https://docs.qq.com/"));
    const documentAddress =
      result.tencentDocUrl || (isDocument(result.url) ? result.url : null);
    const downloadAddress =
      result.downloadUrl || (!documentAddress ? result.url : null);
    return this.complete(job.id, {
      ...(documentAddress
        ? { documentUrl: this.documentUrl(documentAddress) }
        : {}),
      ...(downloadAddress
        ? { downloadUrl: tencentTransferUrl(downloadAddress).href }
        : {}),
      sourceFileSize: result.sourceFileSize,
      fileSize: result.fileSize,
    });
  }

  async wait(id, { timeoutMs = 10 * 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const job = await this.status(id);
      if (
        [
          "completed",
          "failed",
          "needs_attention",
          "user_action_required",
        ].includes(job.state)
      )
        return job;
      if (Date.now() >= deadline) return job;
      await delay(1500);
    }
  }
}
