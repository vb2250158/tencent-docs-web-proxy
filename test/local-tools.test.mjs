import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { ArtifactStore } from "../src/artifacts.mjs";
import { LocalTools, selectedPages } from "../src/local-tools.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "tdocs-local-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir);
  return { store, local: new LocalTools(store) };
}
async function makePdf(store, widths) {
  const pdf = await PDFDocument.create();
  for (const width of widths) pdf.addPage([width, 100]);
  return store.putBuffer(await pdf.save(), "input.pdf", "application/pdf");
}
async function pageWidths(store, artifact) {
  const pdf = await PDFDocument.load(await store.readBuffer(artifact.id));
  return pdf.getPages().map((page) => page.getWidth());
}
test("PDF merge, split, reorder and rotations preserve selected page order", async (t) => {
  const { store, local } = await fixture(t);
  const a = await makePdf(store, [100, 200]);
  const b = await makePdf(store, [300]);
  const merged = await local.pdf("pdf_merge", [a, b]);
  assert.deepEqual(
    await pageWidths(store, merged.artifacts[0]),
    [100, 200, 300],
  );
  const split = await local.pdf("pdf_split", merged.artifacts, {
    groups: [[3, 1], [2]],
  });
  assert.deepEqual(await pageWidths(store, split.artifacts[0]), [300, 100]);
  assert.deepEqual(await pageWidths(store, split.artifacts[1]), [200]);
  const reflow = await local.pdf("pdf_page_reflow", [a], {
    pages: [2, 1, 2],
    rotation: 90,
  });
  const result = await PDFDocument.load(
    await store.readBuffer(reflow.artifacts[0].id),
  );
  assert.deepEqual(
    result
      .getPages()
      .map((page) => [page.getWidth(), page.getRotation().angle]),
    [
      [200, 90],
      [100, 90],
      [200, 90],
    ],
  );
  assert.throws(() => selectedPages("0,1", 2), { code: "INVALID_PAGES" });
});
test("PDF edits are extractable, and render yields actual PNG dimensions", async (t) => {
  const { store, local } = await fixture(t);
  const input = await makePdf(store, [120]);
  const edited = await local.pdf("pdf_edit", [input], {
    edits: [
      { type: "text", text: "Hello test", x: 5, y: 20 },
      { type: "rotate", degrees: 90 },
    ],
  });
  const extracted = await local.extractText(edited.artifacts[0]);
  assert.match(extracted.text, /Hello test/);
  const rendered = await local.renderPdf(edited.artifacts[0], { scale: 1 });
  const meta = await sharp(
    await store.readBuffer(rendered.artifacts[0].id),
  ).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 120);
  const chinese = await local.pdf("pdf_edit", [input], {
    edits: [{ type: "text", text: "中文", x: 5, y: 20 }],
  });
  const chinesePng = await local.renderPdf(chinese.artifacts[0], { scale: 1 });
  const originalPng = await local.renderPdf(input, { scale: 1 });
  assert.notDeepEqual(
    await store.readBuffer(chinesePng.artifacts[0].id),
    await store.readBuffer(originalPng.artifacts[0].id),
  );
});
test("stitching preserves pixel placement and compression produces requested image format", async (t) => {
  const { store, local } = await fixture(t);
  async function img(color, width, height) {
    return store.putBuffer(
      await sharp({ create: { width, height, channels: 3, background: color } })
        .png()
        .toBuffer(),
      `${color}.png`,
      "image/png",
    );
  }
  const a = await img("red", 4, 3);
  const b = await img("blue", 2, 2);
  const result = await local.images("image_stitching", [a, b], {
    direction: "horizontal",
  });
  const { data, info } = await sharp(
    await store.readBuffer(result.artifacts[0].id),
  )
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [6, 3]);
  assert.deepEqual([...data.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...data.subarray(12, 15)], [0, 0, 255]);
  const compressed = await local.images("image_compress", [a], {
    format: "webp",
    quality: 80,
    width: 2,
  });
  const meta = await sharp(
    await store.readBuffer(compressed.artifacts[0].id),
  ).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 2);
  await assert.rejects(local.images("image_compress", [a], { quality: 101 }), {
    code: "INVALID_QUALITY",
  });
});
