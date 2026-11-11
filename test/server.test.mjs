import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../src/server.mjs';
import { request as httpRequest } from 'node:http';

const token = 'test-only-local-api-token-123456789';
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tdocs-server-test-'));
  const calls = [];
  const service = { client: { quota: async () => ({ remainingSeconds: 120 }), history: async () => [], status: async id => ({ taskId: id }) }, submitFile: async (path, spec) => { calls.push({ bytes: await readFile(path, 'utf8'), spec }); return { taskId: 'fixture-task' }; } };
  const server = createProxyServer(service, { root, token, ...overrides });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { root, service, calls, base, auth: { authorization: `Bearer ${token}` } };
}

test('API requires authorization and rejects hostile browser origins and Host headers', async t => {
  const { base, auth } = await fixture(t);
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { ...auth, origin: 'https://example.com' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/health`, { headers: { ...auth, host: 'example.com' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(`${base}/health`, { headers: auth })).status, 200);
});

test('streams binary upload, returns task ID and removes temporary file', async t => {
  const { base, auth, calls, root } = await fixture(t);
  const response = await fetch(`${base}/v1/transcriptions?filename=test.wav&language=16k_en`, { method: 'POST', headers: { ...auth, 'idempotency-key': 'fixture-request', 'content-type': 'audio/wav' }, body: 'synthetic bytes' });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { taskId: 'fixture-task' });
  assert.equal(calls[0].bytes, 'synthetic bytes');
  assert.equal(calls[0].spec.requestId, 'fixture-request');
  // Cleanup occurs after response serialization; close waits for the handler to finish.
  for (let i = 0; i < 20 && (await readdir(root)).length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await readdir(root), []);
});

test('over-limit bodies and missing request identity never call the provider', async t => {
  const { base, auth, calls } = await fixture(t, { maxBytes: 4 });
  let response = await fetch(`${base}/v1/transcriptions?filename=test.wav`, { method: 'POST', headers: auth, body: '123456' });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/v1/transcriptions?filename=test.wav`, { method: 'POST', headers: { ...auth, 'idempotency-key': 'fixture' }, body: '123456' });
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('does not expose unexpected provider errors or log supplied private paths', async t => {
  const logs = [];
  const { base, auth, service } = await fixture(t, { logger: event => logs.push(event) });
  service.client.quota = async () => { throw new Error('fixture-cookie-secret'); };
  const response = await fetch(`${base}/v1/quota`, { headers: auth });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('fixture-cookie-secret'));
  await fetch(`${base}/private-input-value`, { headers: auth });
  assert.ok(!JSON.stringify(logs).includes('private-input-value'));
});
