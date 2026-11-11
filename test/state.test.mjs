import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stateDirectory, saveSession, loadSession } from "../src/state.mjs";

test("refuses runtime data inside the source repository including dot-dot-prefixed child names", () => {
  for (const path of [resolve("."), resolve("state"), resolve("..private")]) {
    assert.throws(() => stateDirectory({ TDOCS_PROXY_STATE_DIR: path }), {
      code: "INVALID_STATE_DIRECTORY",
    });
  }
});

test("stores and reloads a private Tencent Docs session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdocs-state-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cookie = "TOK=fake-test-xsrf; DOC_SID=fake-test-session";
  await saveSession(root, cookie);
  assert.equal(await loadSession(root, {}), cookie);
  const saved = await readFile(
    join(root, process.platform === "win32" ? "session.dpapi" : "session.txt"),
    "utf8",
  );
  if (process.platform === "win32")
    assert.ok(!saved.includes("fake-test-session"));
});
