import test from "node:test";
import assert from "node:assert/strict";
import { ToolboxLimits, staticLimits } from "../src/tool-limits.mjs";
test("documented size and quota IDs remain separate", () => {
  const pdf = staticLimits({ id: "pdf2word" });
  assert.equal(pdf.maxBytes, 100 * 1024 * 1024);
  assert.equal(pdf.maxFiles, 9);
  assert.equal(pdf.rightId, 2);
  assert.equal(staticLimits({ id: "pdf_merge" }).tiers.basic, 10 * 1024 * 1024);
  assert.equal(staticLimits({ id: "office_to_pdf" }).tiers.svip, 1024 ** 3);
  assert.equal(staticLimits({ id: "unknown" }).maxFiles, null);
});
test("live quota distinguishes zero, absent rights, and failed sources", async () => {
  const transport = {
    call: async (name) => {
      if (name === "rights")
        return {
          result: {
            info: [
              { id: 2, rest: 0, total: 10 },
              { id: 3, rest: 7, total: 20 },
            ],
          },
        };
      if (name === "points")
        throw Object.assign(new Error("offline"), { code: "OFFLINE" });
      return { result: { effectivePoolAvailable: false } };
    },
  };
  const result = await new ToolboxLimits(transport).refresh();
  const get = (id) => result.tools.find((item) => item.id === id);
  assert.equal(get("pdf2word").accountRemaining, 0);
  assert.equal(get("pdf2word").quotaStatus, "available");
  assert.equal(get("pdf2excel").accountRemaining, 7);
  assert.equal(get("pdf2ppt").accountRemaining, null);
  assert.equal(get("pdf2ppt").quotaStatus, "unavailable");
  assert.equal(result.points, null);
  assert.deepEqual(result.failures, [{ source: "points", code: "OFFLINE" }]);
});
test("missing or malformed balance does not appear available", async () => {
  const limits = new ToolboxLimits({
    call: async (name) =>
      name === "rights" ? { result: { info: [{ id: 2 }] } } : { result: {} },
  });
  const result = await limits.refresh();
  const word = result.tools.find((item) => item.id === "pdf2word");
  assert.equal(word.accountRemaining, null);
  assert.equal(word.quotaStatus, "unavailable");
});

test("explicit unlimited entitlement overrides its numeric placeholder and voice shares the transcription pool", async () => {
  const source = {
    call: async (name) =>
      name === "rights"
        ? {
            result: {
              info: [
                { id: 2, rest: 1, total: 1, unlimit: true, vipLevel: 3 },
                { id: 25, rest: 35970, total: 36000, unlimit: false },
              ],
            },
          }
        : {
            result: {
              documentRemainingDisplay: "2000.00",
              effectivePoolAvailable: false,
            },
          },
  };
  const result = await new ToolboxLimits(source).refresh();
  assert.equal(
    result.tools.find((tool) => tool.id === "pdf2word").unlimited,
    true,
  );
  const voice = result.tools.find((tool) => tool.id === "voice_notes");
  assert.equal(voice.unlimited, false);
  assert.equal(voice.accountRemaining, 35970);
  assert.equal(voice.sharedWith, "av_to_text");
});
