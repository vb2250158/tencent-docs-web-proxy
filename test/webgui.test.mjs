import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { listToolCatalog } from "../src/tool-catalog.mjs";
import { staticLimits } from "../src/tool-limits.mjs";

async function ready(window, predicate) {
  for (let index = 0; index < 60; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("The UI did not reach the expected state.");
}

test("WebGUI opens without a login dialog and shows catalogue, quotas and matching tool controls", async (t) => {
  const html = await readFile(
    new URL("../web/index.html", import.meta.url),
    "utf8",
  );
  const script = await readFile(
    new URL("../web/app.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:17833/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const catalog = listToolCatalog();
  window.Headers = Headers;
  window.fetch = async (path) => {
    const value =
      path === "/health"
        ? { version: "0.2.0" }
        : path === "/v1/tools"
          ? catalog
          : path === "/v1/jobs"
            ? { jobs: [] }
            : {
                fetchedAt: new Date().toISOString(),
                points: {
                  documentRemaining: "2020.00",
                  buddyOneRemaining: "805.66",
                  preferredPool: "document",
                },
                failures: [],
                tools: catalog.tools.map((tool) => ({
                  id: tool.id,
                  ...staticLimits(tool),
                  ...(tool.id === "av_to_text"
                    ? { accountRemaining: 35980, accountTotal: 36000 }
                    : {}),
                })),
              };
    return { ok: true, json: async () => value };
  };
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.eval(script);
  await ready(
    window,
    () => window.document.querySelectorAll(".tool-card").length === 43,
  );
  const document = window.document;
  assert.equal(document.querySelector("#connect-dialog"), null);
  assert.equal(document.querySelector("#api-token"), null);
  assert.equal(
    document.querySelector("#document-points").textContent,
    "2020.00",
  );
  assert.equal(document.querySelector("#audio-quota").textContent, "599.7");
  assert.ok(
    document.querySelector("#tools-grid").textContent.includes("100 MiB"),
  );
  const search = document.querySelector("#search");
  search.value = "PDF合并";
  search.dispatchEvent(new window.Event("input"));
  assert.equal(document.querySelectorAll(".tool-card").length, 1);
  document.querySelector(".tool-card").click();
  assert.equal(document.querySelector("#tool-dialog").open, true);
  assert.equal(document.querySelector("#dialog-title").textContent, "PDF合并");
  assert.equal(
    document.querySelector("#file-field").classList.contains("hidden"),
    false,
  );
  assert.ok(
    document.querySelector("#dialog-limits").textContent.includes("超级会员"),
  );
  document.querySelector("#close-tool").click();
  assert.equal(document.querySelector("#tool-dialog").open, false);
  let recorder;
  let stopped = false;
  let stopEventFired = false;
  Object.defineProperty(window.navigator, "mediaDevices", {
    value: {
      getUserMedia: async () => ({
        getTracks: () => [
          {
            stop: () => {
              stopped = true;
            },
          },
        ],
      }),
    },
  });
  window.URL.createObjectURL = () => "blob:synthetic-recording";
  window.URL.revokeObjectURL = () => {};
  window.MediaRecorder = class extends window.EventTarget {
    constructor() {
      super();
      this.state = "inactive";
      this.mimeType = "audio/webm";
      recorder = this;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      setTimeout(() => {
        const event = new window.Event("dataavailable");
        Object.defineProperty(event, "data", {
          value: new window.Blob(["synthetic recording"]),
        });
        this.dispatchEvent(event);
        this.dispatchEvent(new window.Event("stop"));
        stopEventFired = true;
      }, 10);
    }
  };
  search.value = "语音速记";
  search.dispatchEvent(new window.Event("input"));
  document.querySelector(".tool-card").click();
  document.querySelector("#start-recording").click();
  await ready(window, () => recorder?.state === "recording");
  document.querySelector("#close-tool").click();
  search.value = "PDF合并";
  search.dispatchEvent(new window.Event("input"));
  document.querySelector(".tool-card").click();
  Object.defineProperty(document.querySelector("#files"), "files", {
    value: [new window.File(["synthetic pdf"], "selected.pdf")],
    configurable: true,
  });
  document.querySelector("#files").dispatchEvent(new window.Event("change"));
  await ready(window, () => stopEventFired);
  assert.equal(stopped, true);
  assert.match(
    document.querySelector("#selected-files").textContent,
    /selected\.pdf/,
  );
  assert.ok(
    !document.querySelector("#selected-files").textContent.includes("语音速记"),
  );
  assert.equal(document.querySelector("#dialog-title").textContent, "PDF合并");
});
