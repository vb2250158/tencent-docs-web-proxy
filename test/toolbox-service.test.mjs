import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolboxService } from "../src/toolbox-service.mjs";
import { ProxyError } from "../src/errors.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tdocs-toolbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ToolboxService({ transport: {} }, root);
  return { root, service };
}

test("an interrupted write is shown as unresolved after restart and is not automatically resubmitted", async (t) => {
  const { root, service } = await fixture(t);
  const claim = await service.jobs.claim("interrupted-write", {
    toolId: "ai_create_mindmap",
    artifacts: [],
    options: { prompt: "fixture" },
  });
  await service.jobs.update(claim.job.id, { state: "generating" });
  const restarted = new ToolboxService({ transport: {} }, root);
  const status = await restarted.status(claim.job.id);
  assert.equal(status.state, "needs_attention");
  assert.equal(status.error.code, "JOB_OUTCOME_UNKNOWN");
  assert.equal(status.requestId, "interrupted-write");
});

test("addon metadata failure still provides an actionable native entry with unknown installation state", async (t) => {
  const { service } = await fixture(t);
  service.transport.addonMetadata = async () => {
    throw new ProxyError("UPSTREAM_NETWORK_ERROR", "Fixture");
  };
  const initial = await service.run(
    "smart_cutout",
    {},
    "addon-metadata-offline",
  );
  const job = await service.wait(initial.id, { timeoutMs: 2000 });
  assert.equal(job.state, "user_action_required");
  assert.equal(job.result.installed, null);
  assert.match(job.result.documentUrl, /^https:\/\/docs\.qq\.com\//);
  assert.ok(!Object.hasOwn(job, "operation"));
});

test("multi-file cloud jobs preserve individual results and never silently drop subsequent inputs", async (t) => {
  const { service } = await fixture(t);
  const inputs = await Promise.all(
    ["first", "second"].map((name) =>
      service.artifacts.putBuffer(Buffer.from(name), `${name}.pdf`),
    ),
  );
  let submissions = 0;
  service.cloud.submit = async () => ({
    kind: "fixture",
    id: String(++submissions),
  });
  service.cloud.status = async (operation) => ({
    state: "completed",
    result: { url: `https://docs.qq.com/doc/fixture-${operation.id}` },
  });
  const initial = await service.run(
    "pdf2word",
    { artifacts: inputs.map((input) => input.id) },
    "two-input-files",
  );
  const job = await service.wait(initial.id, { timeoutMs: 5000 });
  assert.equal(submissions, 2);
  assert.equal(job.state, "completed");
  assert.equal(job.result.documents.length, 2);
});

test("batch jobs keep every download-only result", async (t) => {
  const { service } = await fixture(t);
  const inputs = await Promise.all(
    ["first", "second"].map((name) =>
      service.artifacts.putBuffer(Buffer.from(name), `${name}.docx`),
    ),
  );
  let submitted = 0;
  service.cloud.submit = async () => ({
    kind: "fixture",
    id: String(++submitted),
  });
  service.cloud.status = async (operation) => ({
    state: "completed",
    result: {
      downloadUrl: `https://drive.docs.qq.com/synthetic-${operation.id}`,
    },
  });
  const job = await service.run(
    "file_compress",
    { artifacts: inputs.map((input) => input.id) },
    "batch-download-only",
  );
  const result = await service.wait(job.id, { timeoutMs: 5000 });
  assert.equal(result.state, "completed");
  assert.equal(result.result.downloads.length, 2);
  assert.deepEqual(result.result.downloads.map((item) => item.url).sort(), [
    "https://drive.docs.qq.com/synthetic-1",
    "https://drive.docs.qq.com/synthetic-2",
  ]);
});
