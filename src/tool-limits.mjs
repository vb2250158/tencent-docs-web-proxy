import { listToolCatalog } from "./tool-catalog.mjs";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const source = "https://docs.qq.com/open/toolkit/index.html";

/** Publish explicit static limits and independent live balances without inventing unknown allowances. */
export function staticLimits(tool) {
  const result = {
    source,
    observedAt: "2026-11-11",
    accountRemaining: null,
    quotaStatus: "not_exposed",
    maxBytes: null,
    maxFiles: null,
    maxPages: null,
    maxDurationSeconds: null,
    tiers: null,
    local: null,
  };
  if (["pdf2word", "pdf2excel", "pdf2ppt"].includes(tool.id))
    Object.assign(result, {
      maxBytes: 100 * MIB,
      maxFiles: 9,
      rightId: { pdf2word: 2, pdf2excel: 3, pdf2ppt: 4 }[tool.id],
      quotaStatus: "available",
    });
  if (
    [
      "pdf_edit",
      "pdf_split",
      "pdf_merge",
      "pdf_extract_page",
      "pdf_ocr_text",
      "pdf_page_reflow",
      "pdf_table_extract",
      "pdf_compress",
    ].includes(tool.id)
  )
    result.tiers = {
      basic: 10 * MIB,
      vip: 2 * GIB,
      svip: 2 * GIB,
      svipPlus: 2 * GIB,
    };
  if (
    ["office_to_pdf", "file_to_image", "mind_to_doc", "mind_to_ppt"].includes(
      tool.id,
    )
  )
    result.tiers = {
      basic: 10 * MIB,
      vip: 100 * MIB,
      svip: GIB,
      svipPlus: GIB,
    };
  if (tool.id === "translate")
    result.tiers = {
      basic: 10 * MIB,
      vip: 200 * MIB,
      svip: 200 * MIB,
      svipPlus: 200 * MIB,
    };
  if (tool.id === "av_to_text")
    Object.assign(result, {
      maxBytes: GIB,
      maxFiles: 1,
      maxDurationSeconds: 18000,
      rightId: 25,
      quotaStatus: "available",
      unit: "seconds",
    });
  if (tool.id === "voice_notes")
    Object.assign(result, {
      maxBytes: GIB,
      maxFiles: 1,
      maxDurationSeconds: 18000,
      rightId: 25,
      quotaStatus: "available",
      unit: "seconds",
      sharedWith: "av_to_text",
      sharedLabel: "与音视频转文字共用时长",
    });
  if (
    [
      "image_to_word",
      "image_to_excel",
      "image_to_mindmap",
      "pic_to_resume",
    ].includes(tool.id)
  )
    result.local = {
      maxBytes: 10 * MIB,
      note: "本地图片导入适配器每张最多 10 MiB，腾讯网页具体套餐限制尚未公开读取。",
    };
  if (["image_to_pdf", "image_stitching", "image_compress"].includes(tool.id))
    result.local = {
      maxBytes: 50 * MIB,
      maxPixels: 40_000_000,
      note: "本地图片处理，每张最多 50 MiB、4000 万像素。",
    };
  if (tool.execution === "local") {
    result.quotaStatus = "local";
    result.unlimited = true;
    result.unlimitedScope = "operation_count";
  }
  if (
    [
      "pdf_edit",
      "pdf_extract_page",
      "pdf_page_reflow",
      "pdf_split",
      "pdf_merge",
      "pdf_ocr_text",
      "pdf_table_extract",
      "file_to_image",
    ].includes(tool.id)
  ) {
    result.local = {
      maxBytes: 100 * MIB,
      note: "本地 PDF 解析每文件最多 100 MiB。",
    };
  }
  if (
    [
      "pdf_edit",
      "pdf_split",
      "pdf_extract_page",
      "pdf_page_reflow",
      "pdf_ocr_text",
      "pdf_table_extract",
      "file_to_image",
    ].includes(tool.id)
  )
    result.maxFiles = 1;
  if (tool.addonId) result.quotaStatus = "provider";
  return result;
}

export class ToolboxLimits {
  constructor(transport) {
    this.transport = transport;
    this.cached = null;
  }

  async refresh() {
    const results = await Promise.allSettled([
      this.transport.call("rights", { body: { id: [2, 3, 4, 25] } }),
      this.transport.call("points", { body: {} }),
      this.transport.call("pointsPreference", { body: {} }),
    ]);
    const rights =
      results[0].status === "fulfilled" ? results[0].value.result?.info : null;
    const points =
      results[1].status === "fulfilled" ? results[1].value.result : null;
    const preference =
      results[2].status === "fulfilled" ? results[2].value.result : null;
    const pools = points
      ? {
          documentRemaining: points.documentRemainingDisplay ?? null,
          documentTotal: points.documentTotalDisplay ?? null,
          buddyOneRemaining:
            points.buddyOneBalanceAvailable === true
              ? (points.buddyOneRemainingDisplay ?? null)
              : null,
          combinedRemaining:
            points.combinedBalanceAvailable === true
              ? (points.combinedRemainingDisplay ?? null)
              : null,
          preferredPool:
            preference?.effectivePoolAvailable === true &&
            [0, 1].includes(preference.effectivePool)
              ? preference.effectivePool === 0
                ? "document"
                : "buddyOne"
              : null,
          buddyOneBound: preference?.buddyOneBound ?? null,
        }
      : null;
    const tools = listToolCatalog().tools.map((tool) => {
      const limit = staticLimits(tool);
      const vipLevel = Array.isArray(rights)
        ? rights.find((right) => Number.isInteger(right.vipLevel))?.vipLevel
        : undefined;
      const tier =
        vipLevel === 4
          ? "svipPlus"
          : vipLevel === 3
            ? "svip"
            : vipLevel === 2
              ? "vip"
              : Number.isInteger(vipLevel)
                ? "basic"
                : null;
      if (limit.tiers && tier) {
        limit.currentPlanMaxBytes = limit.tiers[tier];
        limit.currentPlan = {
          basic: "普通账号",
          vip: "会员",
          svip: "超级会员",
          svipPlus: "超级会员 Plus",
        }[tier];
      }
      limit.effectiveMaxBytes = Math.min(
        ...[
          limit.maxBytes,
          limit.currentPlanMaxBytes,
          limit.local?.maxBytes,
          GIB,
        ].filter(Number.isFinite),
      );
      if (limit.rightId && Array.isArray(rights)) {
        const right = rights.find(
          (item) =>
            Number(item.id ?? item.rightId ?? item.right_id) === limit.rightId,
        );
        if (
          right &&
          Number.isFinite(right.rest) &&
          Number.isFinite(right.total)
        ) {
          limit.accountRemaining = right.rest;
          limit.accountTotal = right.total;
          limit.unlimited = right.unlimit === true;
          limit.unlimitedScope =
            right.unlimit === true ? "account_operation_count" : null;
          limit.vipLevel = right.vipLevel ?? null;
        } else limit.quotaStatus = "unavailable";
      }
      if (limit.rightId && !rights) limit.quotaStatus = "unavailable";
      return { id: tool.id, ...limit };
    });
    const invalid = [
      !Array.isArray(rights),
      !points || typeof points.documentRemainingDisplay !== "string",
      !preference || typeof preference.effectivePoolAvailable !== "boolean",
    ];
    this.cached = {
      fetchedAt: new Date().toISOString(),
      points: pools,
      tools,
      failures: results
        .map((result, index) =>
          result.status === "rejected" || invalid[index]
            ? {
                source: ["rights", "points", "preference"][index],
                code: result.reason?.code ?? "UPSTREAM_INVALID_RESPONSE",
              }
            : null,
        )
        .filter(Boolean),
    };
    return this.cached;
  }
}
