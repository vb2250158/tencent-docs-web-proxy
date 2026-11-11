import { ProxyError } from './errors.mjs';

export const DOCS_ORIGIN = 'https://docs.qq.com';
export const ENDPOINTS = Object.freeze({
  quota: '/v2/vipcenter/rights/get',
  credentials: '/v2/drive/tmp/cred',
  mediaInfo: '/api/ai/mediatransform/get_media_info',
  submit: '/api/ai/mediatransform/media_to_tdoc/trans',
  record: '/api/ai/mediatransform/media_to_tdoc/get_record',
  history: '/api/ai/mediatransform/media_to_tdoc/get_records',
});

/** Validate explicit session material; no browser credential database is read. */
export function validateCookie(cookie) {
  if (typeof cookie !== 'string' || !cookie || /[\r\n]/.test(cookie)) {
    throw new ProxyError('LOGIN_REQUIRED', 'Run the login command or configure TDOCS_COOKIE privately.', { status: 401 });
  }
  const match = cookie.match(/(?:^|;\s*)TOK=([^;]+)/);
  if (!match) throw new ProxyError('LOGIN_REQUIRED', 'The Tencent Docs session has no TOK cookie. Sign in again.', { status: 401 });
  return match[1];
}

/** Limit untrusted upstream responses before parsing them. */
async function readJson(response, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new ProxyError('UPSTREAM_RESPONSE_TOO_LARGE', 'Tencent Docs returned an oversized response.');
      chunks.push(chunk);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Tencent Docs did not return valid JSON. Sign in again if the session expired.'); }
}

/** Fixed-origin web transport. Credentials never follow a redirect or caller-selected URL. */
export class WebTransport {
  constructor(cookie, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    this.xsrf = validateCookie(cookie);
    this.cookie = cookie;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async post(path, body, { signal } = {}) {
    if (!Object.values(ENDPOINTS).includes(path)) throw new ProxyError('INVALID_ENDPOINT', 'The requested Tencent Docs endpoint is not supported.', { status: 400 });
    const url = new URL(path, DOCS_ORIGIN);
    url.searchParams.set('xsrf', this.xsrf);
    const abort = AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', cookie: this.cookie, origin: DOCS_ORIGIN, referer: `${DOCS_ORIGIN}/open/toolkit/av-to-text.html` },
        body: body === null ? null : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, abort]) : abort,
      });
    } catch {
      throw new ProxyError('UPSTREAM_NETWORK_ERROR', 'Tencent Docs could not be reached. A submitted task may still have been accepted.');
    }
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-tencent-request-id');
    const details = requestId && /^[\w:.-]{1,160}$/.test(requestId) ? { upstreamRequestId: requestId } : {};
    if (!response.ok) throw new ProxyError('UPSTREAM_HTTP_ERROR', `Tencent Docs returned HTTP ${response.status}.`, { details: { ...details, upstreamStatus: response.status } });
    const data = await readJson(response);
    if (!data || typeof data !== 'object' || !Number.isInteger(data.retcode)) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Tencent Docs response has no numeric retcode.', { details });
    if (data.retcode !== 0) throw new ProxyError('UPSTREAM_REJECTED', 'Tencent Docs rejected the request. Check login, entitlement and input in the web tool.', { status: 422, details: { ...details, retcode: data.retcode } });
    return data.result;
  }
}
