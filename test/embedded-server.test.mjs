import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../src/server.mjs';

test('embedded web app emits prefix-safe assets and same-origin frame CSP', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tdocs-embedded-'));
  const server = createProxyServer({ client: {} }, { root, basePath: '/plugins/tencent', embedded: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Reverse proxy strips the mount prefix before forwarding to this backend.
  const html = await fetch(`${base}/`); const body = await html.text();
  assert.match(body, /data-api-base="\/plugins\/tencent"/);
  assert.match(body, /data-embedded="true"/);
  assert.match(body, /href="\/plugins\/tencent\/style\.css"/);
  assert.match(body, /src="\/plugins\/tencent\/app\.js"/);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
test('standalone disallows framing and invalid mount paths fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tdocs-standalone-'));
  const server = createProxyServer({ client: {} }, { root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const basePath of ['https://example.com', '//evil', '/plugin?x=1', '/a/../b']) assert.throws(() => createProxyServer({}, { root, basePath }), { code: 'INVALID_BASE_PATH' });
});
