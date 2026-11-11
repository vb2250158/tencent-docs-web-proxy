import test from "node:test";
import assert from "node:assert/strict";
import { WebTransport, DOCS_ORIGIN } from "../src/transport.mjs";
import { driveFileId, tencentTransferUrl } from "../src/cloud-conversion.mjs";
const ok = (data) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
test("named routes use a fixed origin, encoding, and protect xsrf from override", async () => {
  const calls = [];
  const transport = new WebTransport("TOK=test", {
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return ok({ ret: 0, operationId: "abc" });
    },
  });
  const result = await transport.call("onlineConvert", {
    body: { docId: "d", dstPadType: 1 },
    query: { xsrf: "hostile" },
  });
  assert.equal(result.operationId, "abc");
  const [url, init] = calls[0];
  assert.equal(url.origin, DOCS_ORIGIN);
  assert.equal(url.pathname, "/api/v1/convert/online2online");
  assert.equal(url.searchParams.get("xsrf"), "test");
  assert.equal(init.redirect, "error");
  assert.equal(init.method, "POST");
  assert.equal(init.body.get("docId"), "d");
  await assert.rejects(transport.call("https://attacker.invalid/"), {
    code: "INVALID_ENDPOINT",
  });
  await assert.rejects(transport.call("constructor"), {
    code: "INVALID_ENDPOINT",
  });
});
test("root responses reject errors, malformed types and missing success marker", async () => {
  let data;
  const transport = new WebTransport("TOK=test", {
    fetchImpl: async () => ok(data),
  });
  for (const [route, bad] of [
    ["rights", { retcode: 4 }],
    ["onlineConvert", { ret: -1 }],
    ["importProgress", { code: 403 }],
  ]) {
    data = bad;
    await assert.rejects(transport.call(route), { code: "UPSTREAM_REJECTED" });
  }
  for (const bad of [[], {}, { result: {} }, { retcode: "0" }]) {
    data = bad;
    await assert.rejects(transport.call("rights"), (error) =>
      ["UPSTREAM_INVALID_RESPONSE", "UPSTREAM_REJECTED"].includes(error.code),
    );
  }
});

test("document editor identifiers resolve to drive file IDs and reject external download origins", () => {
  const fileId = "IFixture123";
  const shortId = `D${Buffer.from(fileId).toString("base64url")}`;
  assert.equal(driveFileId(`https://docs.qq.com/pdf/${shortId}`), fileId);
  assert.throws(() => driveFileId(`https://example.com/pdf/${shortId}`), {
    code: "INVALID_DOCUMENT_URL",
  });
  assert.throws(() => driveFileId("https://docs.qq.com/pdf/invalid"), {
    code: "INVALID_DOCUMENT_URL",
  });
  assert.equal(
    tencentTransferUrl("https://drive.docs.qq.com/download").origin,
    "https://drive.docs.qq.com",
  );
  for (const url of [
    "http://drive.docs.qq.com/download",
    "https://drive.docs.qq.com.attacker.invalid/",
    "https://user:password@drive.docs.qq.com/",
  ])
    assert.throws(() => tencentTransferUrl(url), {
      code: "UNSAFE_FILE_TRANSFER",
    });
});
