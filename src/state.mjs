import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProxyError } from "./errors.mjs";
import { validateCookie } from "./transport.mjs";

/** Runtime data always belongs outside the source checkout. */
export function stateDirectory(env = process.env) {
  const root = resolve(
    env.TDOCS_PROXY_STATE_DIR ||
      join(
        env.LOCALAPPDATA || join(homedir(), ".local", "share"),
        "tencent-docs-web-proxy",
      ),
  );
  const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const rel = relative(source, root);
  if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    throw new ProxyError(
      "INVALID_STATE_DIRECTORY",
      "TDOCS_PROXY_STATE_DIR must be outside the source checkout.",
      { status: 400 },
    );
  return root;
}

/** Write a private file atomically, keeping the previous generation until rename. */
export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

// Fixed code and stdin keep session material out of command lines and shell interpolation.
const DPAPI =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputText); $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; if($env:TDOCS_DPAPI_OPERATION -eq 'protect') { $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope) } else { $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope) }; [Console]::Out.Write([Convert]::ToBase64String($result))";

/** Protect session cookies for the current Windows user without shell-generated commands. */
async function dpapi(value, operation) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TDOCS_DPAPI_OPERATION: operation },
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.on("error", () =>
      reject(
        new ProxyError(
          "SESSION_STORAGE_ERROR",
          "Windows credential protection could not be started.",
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolveResult(Buffer.from(output, "base64"))
        : reject(
            new ProxyError(
              "SESSION_STORAGE_ERROR",
              "Windows could not protect or read this session. Run login as the current Windows user.",
            ),
          ),
    );
    child.stdin.on("error", () => {
      /* Process failure is reported by close/error without leaking stdin. */
    });
    child.stdin.end(Buffer.from(value).toString("base64"));
  });
}

export async function saveSession(root, cookie) {
  validateCookie(cookie);
  const value =
    process.platform === "win32"
      ? (await dpapi(cookie, "protect")).toString("base64")
      : cookie;
  await atomicWrite(
    join(root, process.platform === "win32" ? "session.dpapi" : "session.txt"),
    value,
  );
}

export async function loadSession(root, env = process.env) {
  if (env.TDOCS_COOKIE) {
    validateCookie(env.TDOCS_COOKIE);
    return env.TDOCS_COOKIE;
  }
  try {
    const stored = await readFile(
      join(
        root,
        process.platform === "win32" ? "session.dpapi" : "session.txt",
      ),
      "utf8",
    );
    const cookie =
      process.platform === "win32"
        ? (await dpapi(Buffer.from(stored, "base64"), "unprotect")).toString(
            "utf8",
          )
        : stored;
    validateCookie(cookie);
    return cookie;
  } catch (error) {
    if (error.code === "ENOENT")
      throw new ProxyError(
        "LOGIN_REQUIRED",
        "Run node src/cli.mjs login before using Tencent Docs.",
        { status: 401 },
      );
    throw error;
  }
}

/** One durable request identity prevents unknown submissions being silently replayed. */
export class RequestJournal {
  constructor(root) {
    this.directory = join(root, "requests");
  }
  path(id) {
    return join(
      this.directory,
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }
  async claim(id, fingerprint) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const handle = await open(this.path(id), "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            id,
            fingerprint,
            state: "pending",
            createdAt: new Date().toISOString(),
          }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      return null;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let record;
      try {
        record = JSON.parse(await readFile(this.path(id), "utf8"));
      } catch {
        throw new ProxyError(
          "REQUEST_OUTCOME_UNKNOWN",
          "The request journal is incomplete. Check Tencent Docs history before submitting again.",
          { status: 409, details: { requestId: id } },
        );
      }
      if (record.fingerprint !== fingerprint)
        throw new ProxyError(
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used for a different file or options.",
          { status: 409 },
        );
      if (record.state === "submitted") return record.result;
      throw new ProxyError(
        "REQUEST_OUTCOME_UNKNOWN",
        "The original request has no confirmed task ID. Check history; do not automatically submit it again.",
        { status: 409, details: { requestId: id } },
      );
    }
  }
  async complete(id, fingerprint, result) {
    await atomicWrite(
      this.path(id),
      JSON.stringify({
        id,
        fingerprint,
        state: "submitted",
        result,
        updatedAt: new Date().toISOString(),
      }),
    );
  }
}
