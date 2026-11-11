import test from 'node:test';
import assert from 'node:assert/strict';
import { TencentDocsClient } from '../src/client.mjs';
import { ENDPOINTS } from '../src/transport.mjs';

test('reads transcription entitlement without inventing a zero balance', async () => {
  const client = new TencentDocsClient({ post: async (path, input) => {
    assert.equal(path, ENDPOINTS.quota); assert.deepEqual(input, { id: [25] });
    return { info: [{ rest: 36000, total: 36000 }] };
  } });
  assert.deepEqual(await client.quota(), { remainingSeconds: 36000, totalSeconds: 36000 });
  client.transport.post = async () => ({});
  await assert.rejects(client.quota(), { code: 'UPSTREAM_INVALID_RESPONSE' });
});

test('submits exact observed fields and keeps the task ID', async () => {
  const client = new TencentDocsClient({ post: async (path, input) => {
    assert.equal(path, ENDPOINTS.submit);
    assert.deepEqual(input, { cosURL: 'https://example.invalid/audio.wav', objKey: 'tmp/audio.wav', objName: 'audio.wav', language: '16k_en', speakerDiarization: true, parentName: '' });
    return { taskId: 'task-fixture' };
  } });
  assert.deepEqual(await client.submit({ cosURL: 'https://example.invalid/audio.wav', objectKey: 'tmp/audio.wav', fileName: 'audio.wav', language: '16k_en', speakerDiarization: true }), { taskId: 'task-fixture' });
});

test('distinguishes running, complete, progress failure and business failure', async () => {
  for (const [progress, errCode, state] of [[30, 0, 'processing'], [100, 0, 'completed'], [-1, 0, 'failed'], [100, 9, 'failed']]) {
    const client = new TencentDocsClient({ post: async () => ({ record: { progress, errCode, fileUrl: progress === 100 ? 'https://docs.qq.com/doc/fixture' : '' } }) });
    assert.equal((await client.status('fixture')).state, state);
  }
});

test('poll timeout preserves original task identity and never submits again', async () => {
  const calls = [];
  const client = new TencentDocsClient({ post: async (path, input) => {
    calls.push(path); assert.equal(input.taskId, 'existing-task'); return { record: { progress: 3, errCode: 0 } };
  } });
  await assert.rejects(client.wait('existing-task', { timeoutMs: 0 }), error => error.code === 'POLL_TIMEOUT' && error.details.taskId === 'existing-task');
  assert.deepEqual(calls, [ENDPOINTS.record]);
});

test('rejects unusable or overlong media before submission', async () => {
  for (const duration of [0, 18001, undefined]) {
    const client = new TencentDocsClient({ post: async () => ({ mediaInfo: { audio: { length: duration } } }) });
    await assert.rejects(client.mediaInfo('tmp/fixture'), error => ['INVALID_MEDIA', 'MEDIA_TOO_LONG'].includes(error.code));
  }
});
