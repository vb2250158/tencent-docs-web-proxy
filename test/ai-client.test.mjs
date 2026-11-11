import test from "node:test";
import assert from "node:assert/strict";
import { readAiEvents, ToolboxAiClient } from "../src/ai-client.mjs";

test("SSE decoding preserves split UTF-8 data and multiline JSON frames", async () => {
  const bytes = Buffer.from(
    'event: control\r\ndata: {"messageId":"fixture"}\r\n\r\nevent: content\ndata: {"content":\ndata: {"text":"测试"}}\n\n',
  );
  const events = [];
  await readAiEvents(
    (async function* () {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3);
    })(),
    (type, value) => events.push([type, value]),
  );
  assert.deepEqual(events, [
    ["control", { messageId: "fixture" }],
    ["content", { content: { text: "测试" } }],
  ]);
});

test("AI stream errors and empty closures do not become successful jobs", async () => {
  const client = new ToolboxAiClient({
    xsrf: "fixture",
    cookie: "fixture",
    fetchImpl: async () =>
      new Response('event: error\ndata: {"code":123}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  await assert.rejects(client.generate("mind", "synthetic"), {
    code: "AI_REJECTED",
  });
  client.transport.fetchImpl = async () =>
    new Response("", { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(client.generate("mind", "synthetic"), {
    code: "AI_EMPTY_RESPONSE",
  });
});
