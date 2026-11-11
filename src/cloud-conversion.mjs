import { randomUUID, randomBytes, createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { uploadMedia } from "./upload.mjs";
import { ProxyError } from "./errors.mjs";

/** Only provider-returned HTTPS links on Tencent-owned hosts can be downloaded/uploaded. */
export function tencentTransferUrl(value) {
  let url;
  try {
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    throw new ProxyError(
      "UPSTREAM_INVALID_RESPONSE",
      "The provider returned an invalid file-transfer URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/(?:^|\.)(?:myqcloud\.com|docs\.qq\.com|gtimg\.com)$/.test(url.hostname)
  ) {
    throw new ProxyError(
      "UNSAFE_FILE_TRANSFER",
      "The provider file-transfer address is outside the supported HTTPS hosts.",
    );
  }
  return url;
}

/** Decode Tencent Docs' D-prefixed URL identifier to the drive file ID. */
export function driveFileId(documentUrl) {
  const url = new URL(documentUrl, "https://docs.qq.com");
  if (url.origin !== "https://docs.qq.com")
    throw new ProxyError("INVALID_DOCUMENT_URL", "需要腾讯文档地址。", {
      status: 400,
    });
  const shortId = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^D[A-Za-z0-9_-]+$/.test(shortId))
    throw new ProxyError(
      "INVALID_DOCUMENT_URL",
      "腾讯文档地址缺少可识别的文件编号。",
      { status: 400 },
    );
  const fileId = Buffer.from(shortId.slice(1), "base64url").toString("utf8");
  if (
    !/^I[A-Za-z0-9_-]+$/.test(fileId) ||
    Buffer.from(fileId).toString("base64url") !== shortId.slice(1)
  )
    throw new ProxyError("INVALID_DOCUMENT_URL", "腾讯文档文件编号无法解码。", {
      status: 400,
    });
  return fileId;
}

/** Native file conversion primitives shared by toolbox runners. */
export class CloudConversion {
  constructor(transport, artifacts) {
    this.transport = transport;
    this.artifacts = artifacts;
  }

  async temporaryUpload(artifact) {
    const handle = await open(this.artifacts.path(artifact.id), "r");
    try {
      return await uploadMedia(this.transport, handle, artifact.size);
    } finally {
      await handle.close();
    }
  }

  async importDocument(artifact, { folder = "/" } = {}) {
    const handle = await open(this.artifacts.path(artifact.id), "r");
    const hash = createHash("md5"); // Tencent's legacy import protocol requires this checksum, not an authentication hash.
    try {
      for await (const chunk of handle.createReadStream({
        start: 0,
        end: Math.min(artifact.size, 20 * 1024 * 1024) - 1,
        autoClose: false,
      }))
        hash.update(chunk);
    } finally {
      await handle.close();
    }
    const md5 = hash.digest("hex");
    const authorization = await this.transport.call("importSecret", {
      body: {
        Files: [
          { FileMD5: md5, FileName: artifact.name, FileSize: artifact.size },
        ],
      },
    });
    const credential = authorization.CosKeyList?.[0];
    if (!credential?.CosPutUrl || !credential.CosFileKey)
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "The document-import upload authorization is missing.",
      );
    const url = tencentTransferUrl(credential.CosPutUrl);
    let uploaded;
    try {
      uploaded = await fetch(url, {
        method: "PUT",
        body: this.artifacts.stream(artifact.id),
        duplex: "half",
        redirect: "error",
        headers: { "content-length": String(artifact.size) },
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      throw new ProxyError(
        "UPLOAD_FAILED",
        "The document upload did not complete.",
      );
    }
    if (!uploaded.ok)
      throw new ProxyError(
        "UPLOAD_FAILED",
        `Document upload returned HTTP ${uploaded.status}.`,
      );
    const operationId = randomBytes(16).toString("hex");
    const submitted = await this.transport.call("importFile", {
      body: {
        xsrf: this.transport.xsrf,
        operation_id: operationId,
        cos_file_key: credential.CosFileKey,
        filename: artifact.name,
        md5,
        folder,
        folder_Id: "/",
        async: "1",
      },
    });
    if (
      submitted.ret !== 0 &&
      submitted.retcode !== 0 &&
      submitted.operationId === undefined
    )
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "Document import did not return a confirmed submission.",
      );
    return this.waitImport(operationId);
  }

  async waitImport(operationId, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const response = await this.transport.call("importProgress", {
        query: { operationId },
      });
      const info = response.docInfo;
      if (
        Number(response.progress) === 100 &&
        info?.url &&
        info.localPadId &&
        info.domainId !== undefined
      )
        return info;
      if (Number(response.progress) < 0)
        throw new ProxyError(
          "IMPORT_FAILED",
          "Tencent Docs could not import this file.",
          { details: { operationId } },
        );
      await delay(1000);
    } while (Date.now() < deadline);
    throw new ProxyError(
      "IMPORT_OUTCOME_UNKNOWN",
      "Document import is still unresolved. Reconcile this operation before repeating it.",
      { details: { operationId } },
    );
  }

  async submit(toolId, artifact, options = {}) {
    if (["pdf2word", "pdf2excel", "pdf2ppt"].includes(toolId)) {
      const uploaded = await this.temporaryUpload(artifact);
      const convertType = { pdf2word: 0, pdf2excel: 1, pdf2ppt: 2 }[toolId];
      const response = await this.transport.call("pdfConvert", {
        body: {
          xsrf: this.transport.xsrf,
          convert_type: convertType,
          need_save: true,
          file_passwd: options.password ?? "",
          obj_key: uploaded.objectKey,
        },
      });
      if (!response.result?.taskId)
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "The PDF converter did not return a task ID.",
        );
      return {
        kind: "pdf-office",
        id: response.result.taskId,
        convertType,
        name: artifact.name.replace(/\.pdf$/i, ""),
        title: options.title,
      };
    }
    if (["file_compress", "pdf_compress"].includes(toolId)) {
      const uploaded = await this.temporaryUpload(artifact);
      const response = await this.transport.call("compressSubmit", {
        body: {
          fileType: 1,
          fileID: "",
          compressType: options.level ?? 2,
          folderID: "/",
          ext: extname(artifact.name).slice(1),
          objKey: uploaded.objectKey,
          fileName: artifact.name,
          onlyPreview: 0,
        },
      });
      if (!response.result?.taskID)
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "The file compressor did not return a task ID.",
        );
      return { kind: "compression", id: response.result.taskID };
    }
    if (
      toolId === "office_to_pdf" ||
      toolId === "file_to_image" ||
      ["mind_to_doc", "mind_to_ppt"].includes(toolId)
    ) {
      const doc = options.documentId
        ? { globalId: options.documentId }
        : await this.importDocument(artifact);
      const globalId = doc.globalId ?? `${doc.domainId}$${doc.localPadId}`;
      const response =
        toolId === "office_to_pdf" || toolId === "file_to_image"
          ? await this.transport.call("officePdfSubmit", {
              body: { docID: globalId },
            })
          : await this.transport.call("onlineConvert", {
              body: {
                docId: globalId,
                dstPadType: toolId === "mind_to_doc" ? 1 : 4,
                folder: "/",
              },
            });
      const id = response.operationID ?? response.operationId;
      if (!id)
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "The document converter did not return an operation ID.",
        );
      return {
        kind:
          toolId === "office_to_pdf" || toolId === "file_to_image"
            ? "office-pdf"
            : "online-convert",
        id,
        renderImages: toolId === "file_to_image",
      };
    }
    throw new ProxyError(
      "UNKNOWN_CONVERSION",
      "No cloud converter is registered for this tool.",
      { status: 400 },
    );
  }

  async status(operation) {
    if (operation.kind === "pdf-office") {
      const response = await this.transport.call("pdfProgress", {
        body: { xsrf: this.transport.xsrf, task_id: operation.id },
      });
      const progress = Number(response.result?.status);
      if (!Number.isFinite(progress))
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "The PDF converter returned no progress.",
        );
      return {
        state:
          progress < 0 ? "failed" : progress === 100 ? "needs_save" : "running",
        progress,
      };
    }
    if (operation.kind === "compression") {
      const response = await this.transport.call("compressProgress", {
        body: { taskID: operation.id },
      });
      const result = response.result;
      if (!result)
        throw new ProxyError(
          "UPSTREAM_INVALID_RESPONSE",
          "The compressor returned no result.",
        );
      return {
        state:
          Number(result.status) === 3
            ? "failed"
            : Number(result.percent) === 100
              ? "completed"
              : "running",
        progress: Number(result.percent ?? 0),
        result,
      };
    }
    const response =
      operation.kind === "office-pdf"
        ? await this.transport.call("officePdfProgress", {
            query: { operationID: operation.id },
          })
        : await this.transport.call("onlineProgress", {
            query: { operationId: operation.id },
          });
    return {
      state:
        response.status === "Done"
          ? "completed"
          : response.status === "Fail"
            ? "failed"
            : "running",
      progress: Number(response.progress ?? 0),
      result: { url: response.url ?? response.docUrl },
    };
  }

  async savePdf(operation) {
    const response = await this.transport.call("pdfSave", {
      body: {
        xsrf: this.transport.xsrf,
        convert_type: operation.convertType,
        task_id: operation.id,
        name: operation.title ?? operation.name,
      },
    });
    if (!response.result?.tencentDocUrl)
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "The converted PDF did not produce a saved document URL.",
      );
    return response.result;
  }
}
