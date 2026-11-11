import { ProxyError } from "./errors.mjs";
import { WEB_ROUTES } from "./web-routes.mjs";

export const DOCS_ORIGIN = "https://docs.qq.com";
export const ENDPOINTS = Object.freeze({
  quota: "/v2/vipcenter/rights/get",
  credentials: "/v2/drive/tmp/cred",
  mediaInfo: "/api/ai/mediatransform/get_media_info",
  submit: "/api/ai/mediatransform/media_to_tdoc/trans",
  record: "/api/ai/mediatransform/media_to_tdoc/get_record",
  history: "/api/ai/mediatransform/media_to_tdoc/get_records",
});

/** Validate explicit session material; no browser credential database is read. */
export function validateCookie(cookie) {
  if (typeof cookie !== "string" || !cookie || /[\r\n]/.test(cookie)) {
    throw new ProxyError(
      "LOGIN_REQUIRED",
      "Run the login command or configure TDOCS_COOKIE privately.",
      { status: 401 },
    );
  }
  const match = cookie.match(/(?:^|;\s*)TOK=([^;]+)/);
  if (!match)
    throw new ProxyError(
      "LOGIN_REQUIRED",
      "The Tencent Docs session has no TOK cookie. Sign in again.",
      { status: 401 },
    );
  return match[1];
}

/** Limit untrusted upstream responses before parsing them. */
async function readJson(response, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit)
        throw new ProxyError(
          "UPSTREAM_RESPONSE_TOO_LARGE",
          "Tencent Docs returned an oversized response.",
        );
      chunks.push(chunk);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProxyError(
      "UPSTREAM_INVALID_RESPONSE",
      "Tencent Docs did not return valid JSON. Sign in again if the session expired.",
    );
  }
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
    if (!Object.values(ENDPOINTS).includes(path))
      throw new ProxyError(
        "INVALID_ENDPOINT",
        "The requested Tencent Docs endpoint is not supported.",
        { status: 400 },
      );
    const url = new URL(path, DOCS_ORIGIN);
    url.searchParams.set("xsrf", this.xsrf);
    const abort = AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          cookie: this.cookie,
          origin: DOCS_ORIGIN,
          referer: `${DOCS_ORIGIN}/open/toolkit/av-to-text.html`,
        },
        body: body === null ? null : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, abort]) : abort,
      });
    } catch {
      throw new ProxyError(
        "UPSTREAM_NETWORK_ERROR",
        "Tencent Docs could not be reached. A submitted task may still have been accepted.",
      );
    }
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("x-tencent-request-id");
    const details =
      requestId && /^[\w:.-]{1,160}$/.test(requestId)
        ? { upstreamRequestId: requestId }
        : {};
    if (!response.ok)
      throw new ProxyError(
        "UPSTREAM_HTTP_ERROR",
        `Tencent Docs returned HTTP ${response.status}.`,
        { details: { ...details, upstreamStatus: response.status } },
      );
    const data = await readJson(response);
    if (!data || typeof data !== "object" || !Number.isInteger(data.retcode))
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "Tencent Docs response has no numeric retcode.",
        { details },
      );
    if (data.retcode !== 0)
      throw new ProxyError(
        "UPSTREAM_REJECTED",
        "Tencent Docs rejected the request. Check login, entitlement and input in the web tool.",
        { status: 422, details: { ...details, retcode: data.retcode } },
      );
    return data.result;
  }

  /** Execute one named, fixed-origin toolbox route while retaining its observed root fields. */
  async call(name, { body = {}, query = {}, signal } = {}) {
    const route = Object.hasOwn(WEB_ROUTES, name)
      ? WEB_ROUTES[name]
      : undefined;
    if (!route)
      throw new ProxyError(
        "INVALID_ENDPOINT",
        "Unknown toolbox web operation.",
        { status: 400 },
      );
    return this.requestRoot(route.path, route, { body, query, signal });
  }

  async requestRoot(path, route, { body = {}, query = {}, signal } = {}) {
    const url = new URL(path, DOCS_ORIGIN);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    url.searchParams.set("xsrf", this.xsrf);
    const headers = {
      cookie: this.cookie,
      origin: DOCS_ORIGIN,
      referer: `${DOCS_ORIGIN}/open/toolkit/index.html`,
    };
    let payload;
    if (route.method !== "GET") {
      if (route.encoding === "multipart") {
        payload = body instanceof FormData ? body : new FormData();
        if (!(body instanceof FormData))
          for (const [key, value] of Object.entries(body))
            if (value !== undefined && value !== null)
              payload.set(key, String(value));
      } else {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: route.method,
        headers,
        body: payload,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProxyError(
        "UPSTREAM_NETWORK_ERROR",
        "The toolbox request did not produce a confirmed response. Reconcile a write under its original job ID.",
      );
    }
    if (!response.ok)
      throw new ProxyError(
        "UPSTREAM_HTTP_ERROR",
        `Tencent Docs returned HTTP ${response.status}.`,
        { details: { upstreamStatus: response.status } },
      );
    const data = await readJson(response, 8 * 1024 * 1024);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "The toolbox returned an invalid response.",
      );
    if (
      [
        "/v2/vipcenter/rights/get",
        "/v2/vipcenter/aitoken/get-v2",
        "/v2/vipcenter/aitoken/points/preference/get",
      ].includes(path) &&
      !Number.isInteger(data.retcode)
    )
      throw new ProxyError(
        "UPSTREAM_INVALID_RESPONSE",
        "The entitlement response has no numeric retcode.",
      );
    for (const [field, allowed] of [
      ["retcode", [0]],
      ["ret", [0]],
      ["code", [0, 200]],
    ]) {
      if (data[field] !== undefined && !allowed.includes(data[field]))
        throw new ProxyError(
          "UPSTREAM_REJECTED",
          "The toolbox rejected this operation. Check input, login and entitlement.",
          { status: 422, details: { field, upstreamCode: data[field] } },
        );
    }
    return data;
  }

  /** Read metadata for a known public addon; never contact its external provider with these cookies. */
  async addonMetadata(addonId) {
    if (typeof addonId !== "string" || !/^[a-f0-9]{32}$/.test(addonId))
      throw new ProxyError(
        "INVALID_ADDON_ID",
        "A toolbox addon ID is required.",
        { status: 400 },
      );
    return this.requestRoot(
      `/addon/addons/${addonId}`,
      { method: "GET" },
      { query: { needAuthStatus: 1 } },
    );
  }
}
