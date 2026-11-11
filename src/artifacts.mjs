import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, rmdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./state.mjs";
import { ProxyError } from "./errors.mjs";

export const ARTIFACT_LIMIT = 1024 * 1024 * 1024;

/** Validate a display/download filename without allowing it to select a local path. */
export function artifactName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 240 ||
    /[\x00-\x1f\\/]/.test(value)
  ) {
    throw new ProxyError(
      "INVALID_FILENAME",
      "Supply a plain file name without directory components.",
      { status: 400 },
    );
  }
  return value;
}

/** Private input/output storage; public callers refer to opaque artifact IDs only. */
export class ArtifactStore {
  constructor(root) {
    this.root = join(root, "artifacts");
  }

  directory(id) {
    if (
      typeof id !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
    ) {
      throw new ProxyError(
        "INVALID_ARTIFACT_ID",
        "An artifact ID returned by this service is required.",
        { status: 400 },
      );
    }
    return join(this.root, id);
  }

  path(id) {
    return join(this.directory(id), "content");
  }

  async get(id) {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory(id), "metadata.json"), "utf8"),
      );
      if (
        value.id !== id ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        !/^[a-f0-9]{64}$/.test(value.sha256)
      )
        throw new Error("Invalid artifact metadata");
      artifactName(value.name);
      return value;
    } catch (error) {
      if (error.code === "ENOENT")
        throw new ProxyError(
          "ARTIFACT_NOT_FOUND",
          "This artifact is not present in the local runtime directory.",
          { status: 404 },
        );
      throw error;
    }
  }

  async put(
    source,
    name,
    { mediaType = "application/octet-stream", maxBytes = ARTIFACT_LIMIT } = {},
  ) {
    artifactName(name);
    const id = randomUUID();
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let size = 0;
    let handle;
    try {
      handle = await open(this.path(id), "wx", 0o600);
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes)
          throw new ProxyError(
            "ARTIFACT_TOO_LARGE",
            "The uploaded file exceeds the configured byte limit.",
            { status: 413 },
          );
        hash.update(bytes);
        await handle.writeFile(bytes);
      }
      if (!size)
        throw new ProxyError(
          "EMPTY_ARTIFACT",
          "Provide a nonempty input file.",
          { status: 400 },
        );
      await handle.sync();
      await handle.close();
      handle = undefined;
      const artifact = {
        id,
        name,
        size,
        sha256: hash.digest("hex"),
        mediaType,
        createdAt: new Date().toISOString(),
      };
      await atomicWrite(
        join(directory, "metadata.json"),
        JSON.stringify(artifact),
      );
      return artifact;
    } catch (error) {
      await handle?.close();
      await unlink(this.path(id)).catch((failure) => {
        if (failure.code !== "ENOENT") throw failure;
      });
      await rmdir(directory);
      throw error;
    }
  }

  async importFile(path, name) {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new ProxyError(
          "INVALID_FILE",
          "The input must be a regular file.",
          { status: 400 },
        );
      return await this.put(
        handle.createReadStream({ start: 0, autoClose: false }),
        name,
      );
    } finally {
      await handle.close();
    }
  }

  async putBuffer(bytes, name, mediaType) {
    return this.put([bytes], name, { mediaType });
  }

  async readBuffer(id, limit = 100 * 1024 * 1024) {
    const artifact = await this.get(id);
    if (artifact.size > limit)
      throw new ProxyError(
        "ARTIFACT_TOO_LARGE",
        "The file is too large for this operation.",
        { status: 413 },
      );
    return readFile(this.path(id));
  }

  stream(id) {
    return createReadStream(this.path(id));
  }
}
