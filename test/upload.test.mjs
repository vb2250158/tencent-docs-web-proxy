import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { uploadMedia } from '../src/upload.mjs';

function credential(region = 'ap-guangzhou') {
  return { cred: { bucket: 'fixture-1234567890', region, resource: 'tmp/*', credential: { secretId: 'fixture-only-id', secretKey: 'fixture-only-key', token: 'fixture-only-token' } } };
}

test('uploads through the SDK with the observed Tencent region format and fixed HTTPS destination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tdocs-upload-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'sample');
  await writeFile(path, 'synthetic media');
  const handle = await open(path, 'r');
  t.after(() => handle.close());
  class FakeCos {
    constructor(options) { assert.equal(options.Protocol, 'https:'); assert.equal(options.SecurityToken, 'fixture-only-token'); }
    async putObject(options) {
      assert.equal(options.Bucket, 'fixture-1234567890'); assert.equal(options.Region, 'ap-guangzhou');
      const chunks = [];
      for await (const chunk of options.Body) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), 'synthetic media');
      assert.equal(options.ContentLength, 15);
    }
  }
  const result = await uploadMedia({ post: async () => credential() }, handle, 15, { Cos: FakeCos });
  assert.match(result.objectKey, /^tmp\/[a-f0-9]{32}$/);
  assert.match(result.cosURL, /^https:\/\/fixture-1234567890\.cos\.ap-guangzhou\.myqcloud\.com\/tmp\//);
});

test('rejects an upstream upload destination with URL syntax before forwarding temporary keys', async () => {
  let constructed = false;
  class FakeCos { constructor() { constructed = true; } }
  for (const region of ['ap-guangzhou.evil.invalid', 'ap-guangzhou/../../', 'https://evil.invalid']) {
    await assert.rejects(uploadMedia({ post: async () => credential(region) }, null, 1, { Cos: FakeCos }), { code: 'UPSTREAM_INVALID_RESPONSE' });
  }
  assert.equal(constructed, false);
});
