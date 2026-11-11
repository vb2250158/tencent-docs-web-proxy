import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts.mjs";

test("artifacts preserve bytes behind opaque IDs and reject path-selected reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdocs-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  const artifact = await store.put(
    [Buffer.from("synthetic"), Buffer.from(" bytes")],
    "example.txt",
  );
  assert.equal(
    (await store.readBuffer(artifact.id)).toString(),
    "synthetic bytes",
  );
  assert.equal((await store.get(artifact.id)).size, 15);
  assert.ok(!JSON.stringify(artifact).includes(root));
  await assert.rejects(store.get("../private"), {
    code: "INVALID_ARTIFACT_ID",
  });
  await assert.rejects(store.put(["bytes"], "../unsafe.txt"), {
    code: "INVALID_FILENAME",
  });
});

test("over-limit and empty uploads leave no incomplete artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdocs-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  await assert.rejects(
    store.put(["too large"], "example.txt", { maxBytes: 4 }),
    { code: "ARTIFACT_TOO_LARGE" },
  );
  await assert.rejects(store.put([], "empty.txt"), { code: "EMPTY_ARTIFACT" });
  assert.deepEqual(await readdir(store.root), []);
});
