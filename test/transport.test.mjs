import test from 'node:test';
import assert from 'node:assert/strict';
import { WebTransport, ENDPOINTS } from '../src/transport.mjs';

const cookie = 'TOK=test-xsrf-only; DOC_SID=not-a-real-session';
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('sends the observed web request with cookies, TOK and redirect refusal', async () => {
  const client = new WebTransport(cookie, { fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://docs.qq.com');
    assert.equal(url.pathname, ENDPOINTS.quota);
    assert.equal(url.searchParams.get('xsrf'), 'test-xsrf-only');
    assert.equal(options.headers.cookie, cookie);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { id: [25] });
    return response({ retcode: 0, result: { info: [] } });
  } });
  assert.deepEqual(await client.post(ENDPOINTS.quota, { id: [25] }), { info: [] });
});

test('rejects missing TOK, header injection and caller-selected destinations', async () => {
  assert.throws(() => new WebTransport('DOC_SID=not-real'), { code: 'LOGIN_REQUIRED' });
  assert.throws(() => new WebTransport('TOK=fake\r\nInjected: value'), { code: 'LOGIN_REQUIRED' });
  let calls = 0;
  const client = new WebTransport(cookie, { fetchImpl: async () => { calls++; } });
  await assert.rejects(client.post('https://example.com/', {}), { code: 'INVALID_ENDPOINT' });
  assert.equal(calls, 0);
});

test('does not retry network failures or expose the underlying error', async () => {
  let calls = 0;
  const client = new WebTransport(cookie, { fetchImpl: async () => { calls++; throw new Error(cookie); } });
  await assert.rejects(client.post(ENDPOINTS.submit, {}), error => error.code === 'UPSTREAM_NETWORK_ERROR' && !JSON.stringify(error).includes(cookie));
  assert.equal(calls, 1);
});

test('surfaces business rejection codes without leaking upstream messages', async () => {
  const client = new WebTransport(cookie, { fetchImpl: async () => response({ retcode: 11000, message: cookie }) });
  await assert.rejects(client.post(ENDPOINTS.quota, {}), error => error.code === 'UPSTREAM_REJECTED' && error.details.retcode === 11000 && !JSON.stringify(error).includes(cookie));
});

test('reports malformed and oversized upstream responses', async () => {
  for (const value of ['<html>login</html>', '{}', JSON.stringify({ retcode: '0', result: {} })]) {
    const client = new WebTransport(cookie, { fetchImpl: async () => new Response(value) });
    await assert.rejects(client.post(ENDPOINTS.quota, {}), { code: 'UPSTREAM_INVALID_RESPONSE' });
  }
  const client = new WebTransport(cookie, { fetchImpl: async () => new Response('a'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(client.post(ENDPOINTS.quota, {}), { code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
});
