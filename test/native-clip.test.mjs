import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolboxService } from '../src/toolbox-service.mjs';
import { TencentDocsSessionController } from '../src/session-controller.mjs';
import { ToolboxAiClient } from '../src/ai-client.mjs';

async function fixture(t, progress) {
  const root = await mkdtemp(join(tmpdir(), 'tdocs-clip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const transport = { call: async (name, args) => { calls.push({ name, ...args });
    if (name === 'clipPage') return { result: { padId: 'synthetic-pad', needProgress: true, docUrl: 'https://docs.qq.com/doc/synthetic' } };
    if (name === 'clipProgress') return { result: progress.shift() };
    throw new Error(`Unexpected ${name}`);
  }};
  const service = new ToolboxService({ transport }, root);
  service.official.call = async () => { throw new Error('Native clip must not call official MCP'); };
  return { service, calls };
}
async function submitted(service, key = 'clip-synthetic') {
  const initial = await service.run('web_clipper', { options: { url: 'https://example.com/public' } }, key);
  await service.running.get(initial.id);
  return initial.id;
}
test('cookie-native clip retains operation id and completes only on confirmed progress', async t => {
  const { service, calls } = await fixture(t, [{ progress: 50 }, { progress: 100 }]);
  const id = await submitted(service);
  assert.deepEqual(calls.map(item => item.name), ['clipPage']);
  assert.equal(calls[0].body.url, 'https://example.com/public');
  const first = await service.status(id); assert.equal(first.state, 'running'); assert.equal(first.progress, 50);
  const done = await service.status(id); assert.equal(done.state, 'completed'); assert.equal(done.result.documentUrl, 'https://docs.qq.com/doc/synthetic');
  assert.equal(calls[1].body.operationId, calls[0].body.operationId); assert.equal(calls[1].body.padId, 'synthetic-pad');
  assert.equal((await service.run('web_clipper', { options: { url: 'https://example.com/public' } }, 'clip-synthetic')).id, id);
  assert.equal(calls.filter(item => item.name === 'clipPage').length, 1);
});
test('upstream clip failure never becomes completion', async t => {
  const { service } = await fixture(t, [{ status: 'failed', progress: 100 }]);
  const id = await submitted(service, 'clip-failed');
  const result = await service.status(id); assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'CLIP_FAILED');
});
test('AI authentication observer receives explicit expiry and preserves non-auth rejection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tdocs-observer-'));
  const controller = new TencentDocsSessionController(root, { reuseSessionRoot: false, loadSession: async () => 'TOK=fake; DOC_SID=fake', check: async () => ({}), createToolbox: async client => ({ client, running: new Map() }) });
  t.after(async () => { await controller.dispose(); await rm(root, { recursive: true, force: true }); });
  await controller.initialize();
  const forwarding = controller.client.transport;
  const fakeTransport = { xsrf: 'fake', cookie: 'fake', onAuthenticationFailure: forwarding.onAuthenticationFailure, fetchImpl: async () => new Response(JSON.stringify({ retcode: 99999 }), { headers: { 'content-type': 'application/json' } }) };
  const ai = new ToolboxAiClient(fakeTransport);
  await assert.rejects(ai.generate('mind', 'synthetic'), { code: 'AI_REJECTED' });
  assert.equal(controller.status().state, 'ready');
  fakeTransport.fetchImpl = async () => new Response(JSON.stringify({ retcode: 12100 }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(ai.generate('mind', 'synthetic'), { code: 'AI_REJECTED' });
  assert.equal(controller.status().state, 'login-required'); assert.equal(controller.status().authenticated, false);
});
