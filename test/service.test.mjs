import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptionService } from '../src/service.mjs';
import { ProxyError } from '../src/errors.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tdocs-service-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = join(root, 'fixture.wav');
  await writeFile(media, 'synthetic test bytes');
  let submissions = 0;
  const client = { transport: {}, mediaInfo: async () => ({ durationSeconds: 4 }), submit: async () => { submissions++; return { taskId: 'task-fixture' }; } };
  const service = new TranscriptionService(client, root, { upload: async () => ({ objectKey: 'tmp/test', cosURL: 'https://example.invalid/test' }) });
  return { root, media, client, service, submissions: () => submissions };
}

test('same request, media and options replay the receipt without a second upload or submission', async t => {
  const { service, media, submissions } = await fixture(t);
  const result = await service.submitFile(media, { requestId: 'request-fixture' });
  assert.deepEqual(await service.submitFile(media, { requestId: 'request-fixture' }), result);
  assert.equal(submissions(), 1);
});

test('same request ID cannot silently refer to different input', async t => {
  const { service, media } = await fixture(t);
  await service.submitFile(media, { requestId: 'request-fixture' });
  await writeFile(media, 'different synthetic bytes');
  await assert.rejects(service.submitFile(media, { requestId: 'request-fixture' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('lost submission response is journaled as unknown and cannot be auto-replayed after restart', async t => {
  const { service, media, client, root } = await fixture(t);
  let attempts = 0;
  client.submit = async () => { attempts++; throw new ProxyError('UPSTREAM_NETWORK_ERROR', 'Fixture lost response'); };
  await assert.rejects(service.submitFile(media, { requestId: 'unknown-fixture' }), { code: 'SUBMISSION_OUTCOME_UNKNOWN' });
  const restarted = new TranscriptionService(client, root, { upload: service.upload });
  await assert.rejects(restarted.submitFile(media, { requestId: 'unknown-fixture' }), { code: 'REQUEST_OUTCOME_UNKNOWN' });
  assert.equal(attempts, 1);
});

test('concurrent duplicate requests submit at most once', async t => {
  const { service, media, submissions } = await fixture(t);
  const results = await Promise.allSettled([service.submitFile(media, { requestId: 'concurrent-fixture' }), service.submitFile(media, { requestId: 'concurrent-fixture' })]);
  assert.equal(submissions(), 1);
  assert.ok(results.some(result => result.status === 'fulfilled'));
});

test('file name traversal and speaker/language mismatch fail before any journal writes', async t => {
  const { service, media, root } = await fixture(t);
  await assert.rejects(service.submitFile(media, { fileName: '../private.wav' }), { code: 'INVALID_FILENAME' });
  await assert.rejects(service.submitFile(media, { language: '16k_ja', speakerDiarization: true }), { code: 'INVALID_OPTIONS' });
  assert.deepEqual(await readdir(root), ['fixture.wav']);
});
