import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  unlink,
  rmdir,
  open,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ProxyError, publicError } from "./errors.mjs";
import { MAX_MEDIA_BYTES, submissionOptions } from "./service.mjs";
import { VERSION } from "./version.mjs";

/** Loopback-only HTTP API. It accepts media bytes, never arbitrary local file paths or remote URLs. */
export function createProxyServer(
  service,
  { root, maxBytes = MAX_MEDIA_BYTES, logger = () => {}, basePath = '', embedded = false },
) {
  if (basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw new ProxyError('INVALID_BASE_PATH', 'The embedded application path must be a fixed absolute URL path.', { status: 400 });
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const send = (status, value) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      });
      response.end(JSON.stringify(value));
    };
    let route = "unknown";
    try {
      // Host and Origin validation prevent DNS rebinding and browser-origin credential misuse.
      if (
        !/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host || "") ||
        (request.headers.origin &&
          request.headers.origin !== `http://${request.headers.host}`)
      )
        throw new ProxyError(
          "ORIGIN_REJECTED",
          "Use the loopback API from a local CLI or Agent.",
          { status: 403 },
        );
      const url = new URL(request.url, "http://127.0.0.1");
      route = url.pathname;
      const assets = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      if (request.method === "GET" && assets[route]) {
        const [file, type] = assets[route];
        let content = await readFile(
          new URL(`../web/${file}`, import.meta.url),
        );
        if (file === 'index.html' && basePath) {
          content = Buffer.from(content.toString('utf8').replace('href="/style.css"', `href="${basePath}/style.css"`).replace('src="/app.js"', `src="${basePath}/app.js"`).replace('href="/"', `href="${basePath}/"`).replace('<body>', `<body data-api-base="${basePath}" data-embedded="${embedded ? 'true' : 'false'}">`));
        }
        response.writeHead(200, {
          "content-type": type,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${embedded ? "'self'" : "'none'"}`,
        });
        response.end(content);
        return;
      }
      const readBody = async (limit = 1024 * 1024) => {
        let length = 0;
        const chunks = [];
        for await (const chunk of request.iterator({
          destroyOnReturn: false,
        })) {
          length += chunk.length;
          if (length > limit)
            throw new ProxyError(
              "BODY_TOO_LARGE",
              "Request body is too large.",
              { status: 413 },
            );
          chunks.push(chunk);
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ProxyError(
            "INVALID_JSON",
            "Provide a valid JSON request body.",
            { status: 400 },
          );
        }
      };
      if (request.method === "GET" && route === "/health")
        return send(200, { status: "ok", version: VERSION });
      const toolbox = service.toolbox;
      if (toolbox) {
        if (request.method === "GET" && route === "/v1/translation/languages")
          return send(200, await toolbox.translationLanguages());
        if (request.method === "GET" && route === "/v1/tools")
          return send(200, toolbox.catalog());
        if (request.method === "GET" && route === "/v1/limits")
          return send(
            200,
            toolbox.limits.cached ?? (await toolbox.limits.refresh()),
          );
        if (request.method === "POST" && route === "/v1/limits/refresh")
          return send(200, await toolbox.limits.refresh());
        if (request.method === "GET" && route === "/v1/jobs") {
          const jobs = await toolbox.jobs.recent();
          return send(200, {
            jobs: jobs.map(({ operation, fingerprint, ...visible }) => visible),
          });
        }
        const jobMatch = route.match(/^\/v1\/jobs\/([a-f0-9]{64})$/);
        if (request.method === "GET" && jobMatch)
          return send(200, await toolbox.status(jobMatch[1]));
        const runMatch = route.match(/^\/v1\/tools\/([\w-]+)\/run$/);
        if (request.method === "POST" && runMatch)
          return send(
            202,
            await toolbox.run(
              runMatch[1],
              await readBody(),
              request.headers["idempotency-key"],
            ),
          );
        if (request.method === "POST" && route === "/v1/artifacts") {
          const name = url.searchParams.get("filename");
          const artifact = await toolbox.artifacts.put(
            request.iterator({ destroyOnReturn: false }),
            name,
            {
              mediaType:
                request.headers["content-type"] ?? "application/octet-stream",
            },
          );
          return send(201, artifact);
        }
        const artifactMatch = route.match(
          /^\/v1\/artifacts\/([a-f0-9-]{36})(\/content)?$/,
        );
        if (request.method === "GET" && artifactMatch) {
          const artifact = await toolbox.artifacts.get(artifactMatch[1]);
          if (!artifactMatch[2]) return send(200, artifact);
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": artifact.size,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          });
          toolbox.artifacts
            .stream(artifact.id)
            .on("error", () => response.destroy())
            .pipe(response);
          return;
        }
      }
      if (request.method === "GET" && route === "/v1/quota")
        return send(200, await service.client.quota());
      if (request.method === "GET" && route === "/v1/transcriptions")
        return send(200, { records: await service.client.history() });
      const task = route.match(/^\/v1\/transcriptions\/([^/]+)$/);
      if (request.method === "GET" && task)
        return send(
          200,
          await service.client.status(decodeURIComponent(task[1])),
        );
      if (request.method !== "POST" || route !== "/v1/transcriptions")
        throw new ProxyError("NOT_FOUND", "Unknown API route.", {
          status: 404,
        });
      if (!request.headers["idempotency-key"])
        throw new ProxyError(
          "REQUEST_ID_REQUIRED",
          "Supply a unique Idempotency-Key header for each new transcription.",
          { status: 400 },
        );
      const spec = submissionOptions({
        requestId: request.headers["idempotency-key"],
        fileName: url.searchParams.get("filename"),
        language: url.searchParams.get("language") ?? undefined,
        speakerDiarization: url.searchParams.get("speakers") === "true",
      });
      const length = Number(request.headers["content-length"]);
      if (Number.isFinite(length) && length > maxBytes)
        throw new ProxyError(
          "INVALID_MEDIA_SIZE",
          "The upload exceeds the configured byte limit.",
          { status: 413 },
        );
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, "upload-"));
      const path = join(directory, "media");
      try {
        let received = 0;
        const handle = await open(path, "wx", 0o600);
        try {
          for await (const chunk of request.iterator({
            destroyOnReturn: false,
          })) {
            received += chunk.length;
            if (received > maxBytes)
              throw new ProxyError(
                "INVALID_MEDIA_SIZE",
                "The upload exceeds the configured byte limit.",
                { status: 413 },
              );
            await handle.writeFile(chunk);
          }
        } finally {
          await handle.close();
        }
        return send(202, await service.submitFile(path, spec));
      } finally {
        await unlink(path).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rmdir(directory);
      }
    } catch (error) {
      const failure = publicError(error);
      const safeRoute = route.startsWith("/v1/transcriptions/")
        ? "/v1/transcriptions/:taskId"
        : ["/health", "/v1/quota", "/v1/transcriptions"].includes(route)
          ? route
          : "unknown";
      logger({
        requestId,
        route: safeRoute,
        status: failure.status,
        code: failure.code,
      });
      request.resume();
      if (!response.headersSent && !response.destroyed)
        send(failure.status, { error: failure.toJSON() });
    }
  });
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 30_000;
  server.webGuiUrl = () => `http://127.0.0.1:${server.address().port}/`;
  return server;
}
