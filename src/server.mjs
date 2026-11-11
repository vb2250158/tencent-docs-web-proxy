import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, unlink, rmdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ProxyError, publicError } from './errors.mjs';
import { MAX_MEDIA_BYTES, submissionOptions } from './service.mjs';

function authenticated(header, token) {
  const supplied = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Loopback-only HTTP API. It accepts media bytes, never arbitrary local file paths or remote URLs. */
export function createProxyServer(service, { token, root, maxBytes = MAX_MEDIA_BYTES, logger = () => {} }) {
  if (typeof token !== 'string' || token.length < 24) throw new ProxyError('INVALID_API_TOKEN', 'A local API token of at least 24 characters is required.', { status: 400 });
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId });
      response.end(JSON.stringify(value));
    };
    let route = 'unknown';
    try {
      // Host and Origin validation prevent DNS rebinding and browser-origin credential misuse.
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host || '') || request.headers.origin) throw new ProxyError('ORIGIN_REJECTED', 'Use the loopback API from a local CLI or Agent.', { status: 403 });
      if (!authenticated(request.headers.authorization, token)) throw new ProxyError('UNAUTHORIZED', 'A valid local Bearer token is required.', { status: 401 });
      const url = new URL(request.url, 'http://127.0.0.1');
      route = url.pathname;
      if (request.method === 'GET' && route === '/health') return send(200, { status: 'ok', version: '0.1.0' });
      if (request.method === 'GET' && route === '/v1/quota') return send(200, await service.client.quota());
      if (request.method === 'GET' && route === '/v1/transcriptions') return send(200, { records: await service.client.history() });
      const task = route.match(/^\/v1\/transcriptions\/([^/]+)$/);
      if (request.method === 'GET' && task) return send(200, await service.client.status(decodeURIComponent(task[1])));
      if (request.method !== 'POST' || route !== '/v1/transcriptions') throw new ProxyError('NOT_FOUND', 'Unknown API route.', { status: 404 });
      if (!request.headers['idempotency-key']) throw new ProxyError('REQUEST_ID_REQUIRED', 'Supply a unique Idempotency-Key header for each new transcription.', { status: 400 });
      const spec = submissionOptions({ requestId: request.headers['idempotency-key'], fileName: url.searchParams.get('filename'), language: url.searchParams.get('language') ?? undefined, speakerDiarization: url.searchParams.get('speakers') === 'true' });
      const length = Number(request.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) throw new ProxyError('INVALID_MEDIA_SIZE', 'The upload exceeds the configured byte limit.', { status: 413 });
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, 'upload-'));
      const path = join(directory, 'media');
      try {
        let received = 0;
        const handle = await open(path, 'wx', 0o600);
        try {
          for await (const chunk of request.iterator({ destroyOnReturn: false })) {
            received += chunk.length;
            if (received > maxBytes) throw new ProxyError('INVALID_MEDIA_SIZE', 'The upload exceeds the configured byte limit.', { status: 413 });
            await handle.writeFile(chunk);
          }
        } finally { await handle.close(); }
        return send(202, await service.submitFile(path, spec));
      } finally {
        await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(directory);
      }
    } catch (error) {
      const failure = publicError(error);
      const safeRoute = route.startsWith('/v1/transcriptions/') ? '/v1/transcriptions/:taskId' : ['/health', '/v1/quota', '/v1/transcriptions'].includes(route) ? route : 'unknown';
      logger({ requestId, route: safeRoute, status: failure.status, code: failure.code });
      request.resume();
      if (!response.headersSent && !response.destroyed) send(failure.status, { error: failure.toJSON() });
    }
  });
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 30_000;
  return server;
}
