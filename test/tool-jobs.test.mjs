import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolJobStore } from "../src/tool-jobs.mjs";
import { listToolCatalog } from "../src/tool-catalog.mjs";

test("catalogue has one owner for each unique tool and retains the duplicate category alias", () => {
  const catalog = listToolCatalog();
  assert.equal(catalog.tools.length, 43);
  assert.equal(new Set(catalog.tools.map((tool) => tool.id)).size, 43);
  assert.equal(
    catalog.tools.find((tool) => tool.id === "file_to_image").categories.length,
    2,
  );
});

test("tool request identity survives restarts and does not depend on JSON key order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdocs-jobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ToolJobStore(root);
  const request = {
    toolId: "pdf_split",
    artifacts: ["synthetic-id"],
    options: { pages: "1", title: "sample" },
  };
  const first = await store.claim("fixture-request", request);
  assert.equal(first.created, true);
  const replay = await new ToolJobStore(root).claim("fixture-request", {
    ...request,
    options: { title: "sample", pages: "1" },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, first.job.id);
  await assert.rejects(
    store.claim("fixture-request", { ...request, toolId: "pdf_merge" }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await store.update(first.job.id, {
    state: "completed",
    result: { synthetic: true },
  });
  assert.equal(
    (await store.update(first.job.id, { state: "running" })).state,
    "completed",
  );
});
