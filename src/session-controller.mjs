import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TencentDocsClient } from "./client.mjs";
import { ProxyError } from "./errors.mjs";
import { loadSession, saveSession, stateDirectory } from "./state.mjs";
import { WebTransport, validateCookie } from "./transport.mjs";

const LOGIN_URL = "https://docs.qq.com/open/toolkit/av-to-text.html";
// Tencent's toolkit login handler recognizes these explicit authentication codes.
const AUTH_CODES = new Set([11000, 12100, 11005, 12105, 11006]);

function loginRequired(error) {
  return (
    ["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(error?.code) ||
    error?.details?.upstreamStatus === 401 ||
    (["UPSTREAM_REJECTED", "AI_REJECTED"].includes(error?.code) &&
      AUTH_CODES.has(error.details?.retcode ?? error.details?.upstreamCode))
  );
}

function identityCookie(cookie) {
  validateCookie(cookie);
  const fields = new Map(
    cookie.split(";").map((field) => {
      const separator = field.indexOf("=");
      return [field.slice(0, separator).trim(), field.slice(separator + 1)];
    }),
  );
  if (!(fields.get("DOC_SID") || fields.get("SID") ||
      (fields.get("uid") && fields.get("uid_key"))))
    throw new ProxyError("LOGIN_REQUIRED", "Sign in to your Tencent Docs account.", { status: 401 });
}

function stopped() {
  return new ProxyError("SESSION_DISPOSED", "The Tencent Docs connection has closed.", { status: 503 });
}

/** Cancel one wait without cancelling the shared login or credential check. */
function waitFor(work, signal) {
  if (!signal) return work;
  if (signal.aborted) {
    Promise.resolve(work).catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolveResult, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(work).then(resolveResult, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function launchBrowser(profile) {
  const { chromium } = await import("playwright-core");
  return chromium.launchPersistentContext(profile, { channel: "chrome", headless: false });
}

async function checkSession(cookie, { signal }) {
  const transport = new WebTransport(cookie);
  return new TencentDocsClient({
    post: (path, body) => transport.post(path, body, { signal }),
  }).quota();
}

async function createToolbox(client, root) {
  const { ToolboxService } = await import("./toolbox-service.mjs");
  return new ToolboxService(client, root);
}

/**
 * Own one private Tencent Docs session and one shared interactive login window.
 * initialize() checks saved credentials without opening a window. whenReady()
 * opens login on demand and waits for success. Closing the window rejects its
 * waiters, and subsequent automatic waits stay cancelled until startLogin().
 * The same ToolboxService and forwarding transport survive credential renewal.
 */
export class TencentDocsSessionController {
  #state = "idle";
  #error;
  #revision = 0;
  #cookie;
  #transport;
  #toolbox;
  #initializing;
  #checking;
  #loginWork;
  #loginAbort;
  #context;
  #disposal;
  #lifetime = new AbortController();

  /**
   * @param {string} root Private runtime directory outside the source checkout.
   * @param {object} [options] Optional browser, check, storage and toolbox factories.
   * reuseSessionRoot defaults to the standalone runtime directory and is read-only.
   * Pass false to disable standalone reuse. check receives (cookie, { signal }).
   */
  constructor(root, options = {}) {
    this.root = stateDirectory({ TDOCS_PROXY_STATE_DIR: root });
    this.reuseSessionRoot = options.reuseSessionRoot === false
      ? null
      : resolve(options.reuseSessionRoot ?? stateDirectory());
    this.load = options.loadSession ?? loadSession;
    this.save = options.saveSession ?? saveSession;
    this.check = options.check ?? checkSession;
    this.browserFactory = options.browserFactory ?? launchBrowser;
    this.createToolbox = options.createToolbox ?? createToolbox;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    const forwarding = Object.fromEntries(
      ["post", "call", "requestRoot", "addonMetadata", "fetchImpl"].map((method) => [
        method, (...args) => this.#request(method, args),
      ]),
    );
    for (const property of ["cookie", "xsrf", "timeoutMs"])
      Object.defineProperty(forwarding, property, { get: () => this.#activeTransport()[property] });
    // Direct AI streams parse their own errors and report explicit auth failures here.
    forwarding.onAuthenticationFailure = (error) => this.#authenticationFailure(error);
    this.client = new TencentDocsClient(forwarding);
  }

  /** Return credential-free state suitable for UI polling and tool errors. */
  status() {
    return {
      state: this.#state,
      authenticated: Boolean(this.#transport) && !this.#lifetime.signal.aborted,
      loginOpen: Boolean(this.#context) || this.#state === "logging-in",
      loginRevision: this.#revision,
      ...(this.#error ? { error: { ...this.#error } } : {}),
    };
  }

  /** Check saved credentials once, sharing concurrent initialization. */
  initialize() {
    if (this.#lifetime.signal.aborted) return Promise.reject(stopped());
    this.#initializing ??= this.#initialize();
    return this.#initializing;
  }

  async #initialize() {
    this.#state = "checking";
    try {
      try {
        this.#cookie = await this.load(this.root);
      } catch (error) {
        if (error?.code !== "LOGIN_REQUIRED" || !this.reuseSessionRoot || this.reuseSessionRoot === this.root) throw error;
        this.#cookie = await this.load(this.reuseSessionRoot, {});
      }
      await this.#verifyStored();
    } catch (error) {
      if (!this.#lifetime.signal.aborted) this.#failedCheck(error);
    }
    return this.status();
  }

  #failedCheck(error) {
    if (loginRequired(error)) {
      this.#needsLogin();
      return;
    }
    this.#state = "unavailable";
    this.#error = {
      code: error?.code === "SESSION_STORAGE_ERROR" ? "SESSION_STORAGE_ERROR" : "SESSION_CHECK_UNAVAILABLE",
      message: "The saved Tencent Docs session could not be checked. Retry after the connection or private storage is available.",
    };
  }

  #needsLogin() {
    if (!["login-required", "logging-in", "login-cancelled"].includes(this.#state)) this.#revision++;
    this.#transport = undefined;
    this.#state = "login-required";
    this.#error = undefined;
  }

  async #verifyStored() {
    identityCookie(this.#cookie);
    await waitFor(this.check(this.#cookie, { signal: this.#lifetime.signal }), this.#lifetime.signal);
    await this.#activate(this.#cookie);
  }

  async #activate(cookie, signal = this.#lifetime.signal) {
    if (signal.aborted) throw signal.reason;
    this.#toolbox ??= await this.createToolbox(this.client, this.root);
    if (signal.aborted) throw signal.reason;
    this.#transport = new WebTransport(cookie);
    this.#cookie = cookie;
    this.#state = "ready";
    this.#error = undefined;
  }

  async #request(method, args) {
    const transport = this.#activeTransport();
    try {
      const result = await transport[method](...args);
      if (method === "fetchImpl" && result.status === 401)
        this.#authenticationFailure({ details: { upstreamStatus: 401 } }, transport);
      return result;
    } catch (error) {
      this.#authenticationFailure(error, transport);
      throw error;
    }
  }

  #authenticationFailure(error, transport = this.#transport) {
    if (this.#lifetime.signal.aborted || !transport || transport !== this.#transport || !loginRequired(error)) return false;
    this.#needsLogin();
    return true;
  }

  #activeTransport() {
    if (this.#lifetime.signal.aborted) throw stopped();
    if (!this.#transport) throw new ProxyError("LOGIN_REQUIRED", "Sign in to Tencent Docs before running this tool.", { status: 401 });
    return this.#transport;
  }

  /** Return the stable service after successful login, or a typed safe error. */
  getToolbox() {
    if (this.#lifetime.signal.aborted) throw stopped();
    if (!this.#transport) throw this.#readinessError();
    return this.#toolbox;
  }

  #readinessError() {
    if (this.#state === "login-cancelled")
      return new ProxyError("LOGIN_CANCELLED", "The Tencent Docs login window was closed. Open login to continue.", { status: 409 });
    if (this.#state === "unavailable")
      return new ProxyError(this.#error.code, this.#error.message, { status: 503 });
    return new ProxyError("LOGIN_REQUIRED", "Sign in to your Tencent Docs account to continue.", { status: 401 });
  }

  /**
   * Await the ready service, opening a shared login when credentials are absent.
   * @param {AbortSignal} [signal] Cancels only this caller's wait.
   */
  async whenReady(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    await waitFor(this.initialize(), signal);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (this.#state === "unavailable") {
      this.#checking ??= this.#retryCheck().finally(() => { this.#checking = undefined; });
      await waitFor(this.#checking, signal);
    }
    if (this.#transport) return this.getToolbox();
    if (["unavailable", "login-cancelled"].includes(this.#state)) throw this.#readinessError();
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return waitFor(this.startLogin(), signal);
  }

  async #retryCheck() {
    try {
      if (!this.#cookie) this.#cookie = await this.load(this.root);
      await this.#verifyStored();
    } catch (error) {
      if (!this.#lifetime.signal.aborted) this.#failedCheck(error);
    }
  }

  /** Explicitly open or reuse login, including after the user closed a window. */
  startLogin() {
    if (this.#lifetime.signal.aborted) return Promise.reject(stopped());
    if (!this.#loginWork) {
      this.#loginWork = this.#login().finally(() => { this.#loginWork = undefined; });
      // UI callers may start login without awaiting it. Its safe outcome is in status().
      this.#loginWork.catch(() => {});
    }
    return this.#loginWork;
  }

  async #login() {
    await this.initialize();
    if (this.#transport) return this.getToolbox();
    if (this.#state === "unavailable") throw this.#readinessError();
    if (this.#lifetime.signal.aborted) throw stopped();
    this.#state = "logging-in";
    this.#error = undefined;
    const abort = new AbortController();
    this.#loginAbort = abort;
    const signal = AbortSignal.any([abort.signal, this.#lifetime.signal]);
    let context;
    try {
      context = await this.browserFactory(join(this.root, "login-profile"));
      this.#context = context;
      const closed = () => abort.abort(new ProxyError("LOGIN_CANCELLED", "The Tencent Docs login window was closed.", { status: 409 }));
      context.on("close", closed);
      try {
        if (signal.aborted) throw signal.reason;
        const page = context.pages()[0] ?? await waitFor(context.newPage(), signal);
        await waitFor(page.goto(LOGIN_URL), signal);
        let rejectedCookie;
        while (!signal.aborted) {
          const cookie = (await waitFor(context.cookies("https://docs.qq.com/"), signal))
            .map((item) => `${item.name}=${item.value}`).join("; ");
          try {
            identityCookie(cookie);
            if (cookie !== rejectedCookie) {
              await waitFor(this.check(cookie, { signal }), signal);
              if (signal.aborted) throw signal.reason;
              await this.save(this.root, cookie);
              if (signal.aborted) throw signal.reason;
              await this.#activate(cookie, signal);
              return this.getToolbox();
            }
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (loginRequired(error)) rejectedCookie = cookie;
            else if (["UPSTREAM_NETWORK_ERROR", "UPSTREAM_HTTP_ERROR", "UPSTREAM_INVALID_RESPONSE"].includes(error?.code))
              this.#error = { code: "SESSION_CHECK_UNAVAILABLE", message: "Tencent Docs could not be reached. Login will be checked again while this window is open." };
            else throw error;
          }
          await delay(this.pollIntervalMs, undefined, { signal });
        }
        throw signal.reason;
      } finally {
        context.off("close", closed);
      }
    } catch (error) {
      if (signal.aborted) error = signal.reason;
      if (!this.#lifetime.signal.aborted) {
        this.#state = error?.code === "LOGIN_CANCELLED" ? "login-cancelled" : "login-required";
        this.#error = {
          code: error?.code === "LOGIN_CANCELLED" ? "LOGIN_CANCELLED" : "LOGIN_FAILED",
          message: error?.code === "LOGIN_CANCELLED" ? "The Tencent Docs login window was closed. Open login to continue." : "Tencent Docs login could not finish. Check Chrome and private session storage, then open login again.",
        };
      }
      throw this.#lifetime.signal.aborted ? stopped() : new ProxyError(this.#error.code, this.#error.message, { status: 409 });
    } finally {
      this.#loginAbort = undefined;
      if (context) {
        try {
          await context.close();
          if (this.#context === context) this.#context = undefined;
        } catch (error) {
          // Keep the context owned for a disposal retry and report cleanup failure safely.
          this.#error = { code: "LOGIN_WINDOW_CLOSE_FAILED", message: "The login window could not be closed automatically. Close it in Chrome." };
        }
      }
    }
  }

  /** Cancel login, close its browser, drain accepted jobs and release official MCP. */
  dispose() {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  async #dispose() {
    this.#lifetime.abort(stopped());
    this.#loginAbort?.abort(stopped());
    this.#state = "disposed";
    await Promise.allSettled([this.#initializing, this.#checking, this.#loginWork]);
    if (this.#context) {
      await this.#context.close();
      this.#context = undefined;
    }
    if (this.#toolbox) {
      await Promise.allSettled([...(this.#toolbox.running?.values() ?? [])]);
      await this.#toolbox.official?.close();
    }
    this.#transport = undefined;
    this.#cookie = undefined;
  }
}
