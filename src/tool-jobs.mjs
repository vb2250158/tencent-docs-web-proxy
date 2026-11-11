import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { atomicWrite } from "./state.mjs";
import { ProxyError } from "./errors.mjs";

/** Stable serialization makes idempotency independent of JSON property ordering. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/** Durable toolbox jobs; an existing request never starts its write operation again. */
export class ToolJobStore {
  constructor(root) {
    this.root = join(root, "tool-jobs");
  }

  path(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new ProxyError(
        "INVALID_JOB_ID",
        "Use a job ID returned by this service.",
        { status: 400 },
      );
    return join(this.root, `${id}.json`);
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT")
        throw new ProxyError(
          "JOB_NOT_FOUND",
          "The toolbox job was not found.",
          { status: 404 },
        );
      if (error instanceof SyntaxError)
        throw new ProxyError(
          "JOB_OUTCOME_UNKNOWN",
          "The job receipt is incomplete. Reconcile the original request before repeating it.",
          { status: 409, details: { jobId: id } },
        );
      throw error;
    }
  }

  async recent(limit = 30) {
    let entries;
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const results = await Promise.allSettled(
      entries
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => this.get(name.slice(0, -5))),
    );
    return results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async claim(requestId, request) {
    if (typeof requestId !== "string" || !/^[\w.-]{1,128}$/.test(requestId))
      throw new ProxyError(
        "INVALID_REQUEST_ID",
        "Supply a stable request ID containing 1–128 letters, digits, dots, hyphens or underscores.",
        { status: 400 },
      );
    const id = createHash("sha256").update(requestId).digest("hex");
    const fingerprint = createHash("sha256")
      .update(canonicalJson(request))
      .digest("hex");
    const job = {
      id,
      requestId,
      fingerprint,
      toolId: request.toolId,
      inputArtifacts: request.artifacts,
      options: request.options,
      state: "preparing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(this.path(id), "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(job));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { created: true, job };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await this.get(id);
      if (existing.fingerprint !== fingerprint)
        throw new ProxyError(
          "IDEMPOTENCY_CONFLICT",
          "This request ID belongs to a different tool, input or options.",
          { status: 409 },
        );
      return { created: false, job: existing };
    }
  }

  async update(id, changes) {
    const current = await this.get(id);
    if (["completed", "failed"].includes(current.state)) return current;
    const next = {
      ...current,
      ...changes,
      id,
      fingerprint: current.fingerprint,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(this.path(id), JSON.stringify(next));
    return next;
  }
}
