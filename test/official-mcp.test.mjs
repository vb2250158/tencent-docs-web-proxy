import test from "node:test";
import assert from "node:assert/strict";
import { OfficialDocsMcp } from "../src/official-mcp.mjs";

test("official tool uses a fixed destination, explicit protocol and scoped authorization", async () => {
  const client = new OfficialDocsMcp({
    tokenProvider: async () => "fixture-token",
    fetchImpl: async (url, input) => {
      assert.equal(url, "https://docs.qq.com/openapi/mcp");
      assert.equal(input.redirect, "error");
      assert.equal(input.headers.Authorization, "fixture-token");
      assert.equal(input.headers["MCP-Protocol-Version"], "2025-06-18");
      const body = JSON.parse(input.body);
      assert.equal(body.method, "tools/call");
      assert.deepEqual(body.params, {
        name: "scrape_progress",
        arguments: { task_id: "fixture-task" },
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: '{"status":"completed"}' }],
          },
        }),
      );
    },
  });
  assert.deepEqual(
    await client.call("scrape_progress", { task_id: "fixture-task" }),
    { status: "completed" },
  );
});

test("official SSE and error results are parsed without retrying a lost create response", async () => {
  let calls = 0;
  const client = new OfficialDocsMcp({
    tokenProvider: async () => "fixture-token",
    fetchImpl: async () => {
      calls++;
      throw new Error("lost request");
    },
  });
  await assert.rejects(
    client.call("create_slide", { description: "fixture" }),
    { code: "MCP_REQUEST_INTERRUPTED" },
  );
  assert.equal(calls, 1);
  client.fetchImpl = async () =>
    new Response(
      'event: message\ndata: {"id":1,"result":{"content":[{"type":"text","text":"{\\"status\\":\\"in_progress\\"}"}]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  assert.deepEqual(
    await client.call("slide_progress", { session_id: "fixture" }),
    { status: "in_progress" },
  );
  client.fetchImpl = async () =>
    new Response('{"id":1,"error":{"code":-32000,"message":"fixture-token"}}');
  await assert.rejects(
    client.call("slide_progress", { session_id: "fixture" }),
    (error) =>
      error.code === "MCP_TOOL_FAILED" &&
      !JSON.stringify(error).includes("fixture-token"),
  );
});
