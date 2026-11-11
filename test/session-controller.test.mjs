import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProxyError } from "../src/errors.mjs";
import { TencentDocsSessionController } from "../src/session-controller.mjs";

const COOKIE = "TOK=fake-test-token; DOC_SID=fake-test-session";
const missing = () => new ProxyError("LOGIN_REQUIRED", "Test session is missing.");
const quota = { remainingSeconds: 100, totalSeconds: 200 };

class LoginBrowser extends EventEmitter {
  cookie = "";
  closes = 0;
  visits = [];
  pages() { return [{ goto: async (url) => { this.visits.push(url); } }]; }
  async cookies() {
    return this.cookie ? this.cookie.split("; ").map((field) => {
      const separator = field.indexOf("=");
      return { name: field.slice(0, separator), value: field.slice(separator + 1) };
    }) : [];
  }
  async close() { this.closes++; this.emit("close"); }
}

async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "tdocs-controller-test-"));
  const browser = new LoginBrowser();
  const stats = { launches: 0, saved: [], checked: [], creates: 0, releases: 0 };
  const controller = new TencentDocsSessionController(root, {
    reuseSessionRoot: false,
    loadSession: async () => { throw missing(); },
    saveSession: async (...args) => { stats.saved.push(args); },
    check: async (cookie) => { stats.checked.push(cookie); return quota; },
    browserFactory: async (profile) => { stats.launches++; stats.profile = profile; return browser; },
    createToolbox: async (client) => {
      stats.creates++;
      return { client, running: new Map(), official: { close: async () => { stats.releases++; } } };
    },
    pollIntervalMs: 5,
    ...overrides,
  });
  t.after(async () => { await controller.dispose(); await rm(root, { recursive: true, force: true }); });
  return { controller, browser, stats, root };
}

async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail("Synthetic login did not reach its expected state.");
}

test("valid saved identity is checked once and reused without opening Chrome", async (t) => {
  const { controller, stats } = await setup(t, { loadSession: async () => COOKIE });
  const [first, second] = await Promise.all([controller.initialize(), controller.initialize()]);
  assert.equal(first.authenticated, true);
  assert.equal(second.state, "ready");
  assert.equal(await controller.whenReady(), controller.getToolbox());
  assert.equal(stats.launches, 0);
  assert.equal(stats.checked.length, 1);
  assert.equal(stats.saved.length, 0);
  assert.ok(!JSON.stringify(controller.status()).includes("fake-test"));
});

test("standalone reuse reads its existing session without saving or copying its browser profile", async (t) => {
  const calls = [];
  const external = join(tmpdir(), "tdocs-fake-standalone");
  const { controller, stats } = await setup(t, {
    reuseSessionRoot: external,
    loadSession: async (root, env) => { calls.push({ root, env }); if (root !== external) throw missing(); return COOKIE; },
  });
  await controller.initialize();
  assert.equal(controller.status().authenticated, true);
  assert.deepEqual(calls[1], { root: external, env: {} });
  assert.equal(stats.saved.length, 0);
  assert.equal(stats.launches, 0);
});

test("login validates identity and quota then persists and closes automatically", async (t) => {
  const { controller, browser, stats, root } = await setup(t);
  const ready = controller.whenReady();
  await until(() => stats.launches === 1);
  browser.cookie = "TOK=fake-test-token";
  await delay(20);
  assert.equal(stats.checked.length, 0);
  browser.cookie = COOKIE;
  const toolbox = await ready;
  assert.equal(toolbox, controller.getToolbox());
  assert.deepEqual(stats.saved, [[root, COOKIE]]);
  assert.equal(stats.profile, join(root, "login-profile"));
  assert.equal(browser.visits[0], "https://docs.qq.com/open/toolkit/av-to-text.html");
  assert.equal(browser.closes, 1);
  assert.equal(controller.status().loginOpen, false);
});

test("concurrent waiters share one window and cancelling a caller leaves login running", async (t) => {
  const { controller, browser, stats } = await setup(t);
  const caller = new AbortController();
  const cancelled = controller.whenReady(caller.signal);
  const ready = controller.whenReady();
  await until(() => stats.launches === 1);
  caller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(browser.closes, 0);
  browser.cookie = COOKIE;
  assert.equal(await ready, controller.getToolbox());
  assert.equal(stats.launches, 1);
});

test("closing login settles all waiters and blocks automatic reopen until explicit login", async (t) => {
  const { controller, browser, stats } = await setup(t);
  const pending = controller.whenReady();
  await until(() => stats.launches === 1);
  const revision = controller.status().loginRevision;
  browser.emit("close");
  await assert.rejects(pending, { code: "LOGIN_CANCELLED" });
  await assert.rejects(controller.whenReady(), { code: "LOGIN_CANCELLED" });
  assert.equal(stats.launches, 1);
  assert.equal(controller.status().loginRevision, revision);
  browser.cookie = COOKIE;
  await controller.startLogin();
  assert.equal(stats.launches, 2);
  assert.equal(controller.status().state, "ready");
});

test("dispose cancels pending login and releases resources without waiting for user sign-in", async (t) => {
  const { controller, stats, browser } = await setup(t);
  const pending = controller.whenReady();
  await until(() => stats.launches === 1);
  const rejected = assert.rejects(pending, { code: "SESSION_DISPOSED" });
  await controller.dispose();
  await rejected;
  assert.equal(controller.status().state, "disposed");
  assert.equal(controller.status().authenticated, false);
  assert.equal(browser.closes, 1);
  assert.equal(stats.saved.length, 0);
  await assert.rejects(controller.whenReady(), { code: "SESSION_DISPOSED" });
});

test("missing identity and explicit upstream authentication errors request login", async (t) => {
  for (const cookie of ["TOK=fake-test-token", COOKIE]) {
    const { controller, stats } = await setup(t, {
      loadSession: async () => cookie,
      check: async () => { throw new ProxyError("UPSTREAM_REJECTED", "Test rejection.", { details: { retcode: 11000 } }); },
    });
    await controller.initialize();
    assert.equal(controller.status().state, "login-required");
    assert.equal(controller.status().authenticated, false);
    assert.equal(stats.saved.length, 0);
  }
});

test("network failures retain saved credentials and retry checks without opening login", async (t) => {
  let online = false;
  const { controller, stats } = await setup(t, {
    loadSession: async () => COOKIE,
    check: async () => { if (!online) throw new ProxyError("UPSTREAM_NETWORK_ERROR", "Test connection failure."); return quota; },
  });
  await controller.initialize();
  assert.equal(controller.status().state, "unavailable");
  await assert.rejects(controller.whenReady(), { code: "SESSION_CHECK_UNAVAILABLE" });
  await assert.rejects(controller.startLogin(), { code: "SESSION_CHECK_UNAVAILABLE" });
  assert.equal(stats.launches, 0);
  assert.equal(stats.saved.length, 0);
  online = true;
  await controller.whenReady();
  assert.equal(controller.status().authenticated, true);
  assert.equal(stats.launches, 0);
});

test("unknown rejection and HTTP403 do not discard sessions or open login", async (t) => {
  for (const details of [{ retcode: 99999 }, { upstreamStatus: 403 }]) {
    const { controller, stats } = await setup(t, {
      loadSession: async () => COOKIE,
      check: async () => { throw new ProxyError("UPSTREAM_REJECTED", "Test denial.", { details }); },
    });
    await controller.initialize();
    await assert.rejects(controller.whenReady(), { code: "SESSION_CHECK_UNAVAILABLE" });
    assert.equal(stats.launches, 0);
  }
});

test("UID identity is accepted and service/client/transport references survive a renewal", async (t) => {
  const { controller, browser, stats } = await setup(t, { loadSession: async () => COOKIE });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("", { status: 401 });
  await controller.initialize();
  const toolbox = controller.getToolbox();
  const transport = toolbox.client.transport;
  await assert.rejects(transport.post("/v2/vipcenter/rights/get", {}), { code: "UPSTREAM_HTTP_ERROR" });
  assert.equal(controller.status().state, "login-required");
  const ready = controller.whenReady();
  await until(() => stats.launches === 1);
  browser.cookie = "TOK=fake-renewed-token; uid=fake-user; uid_key=fake-user-key";
  assert.equal(await ready, toolbox);
  assert.equal(controller.getToolbox().client.transport, transport);
  assert.equal(transport.xsrf, "fake-renewed-token");
  assert.equal(stats.creates, 1);
});

test("failed quota check in the login window retries connection and saves only verified credentials", async (t) => {
  let checks = 0;
  const { controller, browser, stats } = await setup(t, {
    check: async () => { checks++; if (checks === 1) throw new ProxyError("UPSTREAM_NETWORK_ERROR", "Test outage."); return quota; },
  });
  browser.cookie = COOKIE;
  await controller.whenReady();
  assert.equal(checks, 2);
  assert.equal(stats.saved.length, 1);
  assert.equal(controller.status().authenticated, true);
});

test("browser launch failures are safe and dispose closes an in-flight late launch", async (t) => {
  const failure = await setup(t, { browserFactory: async () => { throw new Error(COOKIE); } });
  await assert.rejects(failure.controller.whenReady(), (error) => error.code === "LOGIN_FAILED" && !error.message.includes("fake-test"));
  assert.ok(!JSON.stringify(failure.controller.status()).includes("fake-test"));
  let launched;
  const launch = new Promise((resolveResult) => { launched = resolveResult; });
  const late = await setup(t, { browserFactory: async () => launch });
  const pending = late.controller.whenReady();
  await until(() => late.controller.status().state === "logging-in");
  const rejected = assert.rejects(pending, { code: "SESSION_DISPOSED" });
  const disposal = late.controller.dispose();
  launched(late.browser);
  await disposal;
  await rejected;
  assert.equal(late.browser.closes, 1);
  assert.equal(late.stats.saved.length, 0);
});

test("closing login during quota validation prevents late persistence or authentication", async (t) => {
  let checked;
  let started = false;
  const check = new Promise((resolveResult) => { checked = resolveResult; });
  const { controller, browser, stats } = await setup(t, {
    check: async () => { started = true; return check; },
  });
  browser.cookie = COOKIE;
  const pending = controller.whenReady();
  await until(() => started);
  browser.emit("close");
  await assert.rejects(pending, { code: "LOGIN_CANCELLED" });
  checked(quota);
  await delay(10);
  assert.equal(stats.saved.length, 0);
  assert.equal(controller.status().authenticated, false);
});

test("dispose interrupts a saved-session check and releases the stable service once", async (t) => {
  let started = false;
  const pendingCheck = await setup(t, {
    loadSession: async () => COOKIE,
    check: async () => { started = true; return new Promise(() => {}); },
  });
  const initialize = pendingCheck.controller.initialize();
  await until(() => started);
  await pendingCheck.controller.dispose();
  assert.equal((await initialize).state, "disposed");
  const ready = await setup(t, { loadSession: async () => COOKIE });
  await ready.controller.initialize();
  const first = ready.controller.dispose();
  assert.equal(ready.controller.dispose(), first);
  await first;
  assert.equal(ready.stats.releases, 1);
});

test("AI auth observer invalidates explicit expiry without opening login or replacing the service", async (t) => {
  const { controller, browser, stats } = await setup(t, { loadSession: async () => COOKIE });
  await controller.initialize();
  const toolbox = controller.getToolbox();
  const observer = toolbox.client.transport.onAuthenticationFailure;
  const revision = controller.status().loginRevision;
  for (const error of [
    new ProxyError("AI_REJECTED", "Test credit failure.", { details: { upstreamCode: 99999 } }),
    new ProxyError("UPSTREAM_NETWORK_ERROR", "Test outage."),
  ]) {
    assert.equal(observer(error), false);
    assert.equal(controller.status().state, "ready");
  }
  const expired = new ProxyError("AI_REJECTED", "Test expiry.", { details: { upstreamCode: 12100 } });
  assert.equal(observer(expired), true);
  assert.equal(controller.status().state, "login-required");
  assert.equal(controller.status().authenticated, false);
  assert.equal(controller.status().loginRevision, revision + 1);
  assert.equal(observer(expired), false);
  assert.equal(stats.launches, 0);
  assert.equal(stats.saved.length, 0);
  assert.throws(() => controller.getToolbox(), { code: "LOGIN_REQUIRED" });
  browser.cookie = COOKIE;
  assert.equal(await controller.whenReady(), toolbox);
  assert.equal(stats.creates, 1);
  await controller.dispose();
  assert.equal(observer(expired), false);
  assert.equal(controller.status().state, "disposed");
});
