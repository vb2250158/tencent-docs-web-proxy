import sharp from "sharp";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { ProxyError } from "./errors.mjs";

/** Resolve explicit one-based page selections; page order and duplicates are intentional. */
export function selectedPages(selection, count) {
  const values =
    selection === undefined
      ? Array.from({ length: count }, (_, i) => i + 1)
      : Array.isArray(selection)
        ? selection
        : typeof selection === "string"
          ? selection.split(",").flatMap((part) => {
              const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
              if (!match)
                throw new ProxyError(
                  "INVALID_PAGES",
                  "Use one-based pages such as 1,3-5.",
                  { status: 400 },
                );
              const start = Number(match[1]);
              const end = Number(match[2] ?? match[1]);
              if (end < start || end - start > 10000)
                throw new ProxyError(
                  "INVALID_PAGES",
                  "The page range is invalid.",
                  { status: 400 },
                );
              return Array.from(
                { length: end - start + 1 },
                (_, i) => start + i,
              );
            })
          : [];
  if (
    !values.length ||
    values.length > 10000 ||
    values.some((page) => !Number.isInteger(page) || page < 1 || page > count)
  )
    throw new ProxyError(
      "INVALID_PAGES",
      `Choose pages between 1 and ${count}.`,
      { status: 400 },
    );
  return values.map((page) => page - 1);
}

/** Local equivalents for file operations performed in the toolbox's client-side editors. */
export class LocalTools {
  constructor(artifacts) {
    this.artifacts = artifacts;
  }

  async pdf(toolId, inputs, options = {}) {
    const buffers = await Promise.all(
      inputs.map((input) => this.artifacts.readBuffer(input.id)),
    );
    const documents = await Promise.all(
      buffers.map((bytes) => PDFDocument.load(bytes)),
    );
    const save = async (document, name) =>
      this.artifacts.putBuffer(await document.save(), name, "application/pdf");
    if (toolId === "pdf_merge") {
      const result = await PDFDocument.create();
      for (const document of documents)
        for (const page of await result.copyPages(
          document,
          document.getPageIndices(),
        ))
          result.addPage(page);
      return { artifacts: [await save(result, options.name ?? "merged.pdf")] };
    }
    const document = documents[0];
    if (toolId === "pdf_split") {
      const groups =
        options.groups ??
        Array.from({ length: document.getPageCount() }, (_, i) => [i + 1]);
      if (!Array.isArray(groups) || !groups.length || groups.length > 1000)
        throw new ProxyError(
          "INVALID_PAGES",
          "Supply at most 1000 page groups.",
          { status: 400 },
        );
      const outputs = [];
      for (const [index, group] of groups.entries()) {
        const result = await PDFDocument.create();
        for (const page of await result.copyPages(
          document,
          selectedPages(group, document.getPageCount()),
        ))
          result.addPage(page);
        outputs.push(await save(result, `split-${index + 1}.pdf`));
      }
      return { artifacts: outputs };
    }
    if (toolId === "pdf_edit") {
      if (!Array.isArray(options.edits) || !options.edits.length)
        throw new ProxyError(
          "EDITS_REQUIRED",
          "Provide edits (text, rectangle or rotation), or use the native editor session for interactive editing.",
          { status: 400 },
        );
      const font = await document.embedFont(StandardFonts.Helvetica);
      for (const edit of options.edits) {
        const page = document.getPage(
          selectedPages([edit.page ?? 1], document.getPageCount())[0],
        );
        if (edit.type === "rotate") {
          page.setRotation(degrees(edit.degrees));
          continue;
        }
        const x = Number(edit.x ?? 0);
        const y = Number(edit.y ?? 0);
        if (![x, y].every(Number.isFinite))
          throw new ProxyError(
            "INVALID_EDIT",
            "Edit coordinates must be finite numbers.",
            { status: 400 },
          );
        if (edit.type === "text") {
          if (typeof edit.text !== "string" || !edit.text.trim())
            throw new ProxyError("INVALID_EDIT", "请输入要添加的文字。", {
              status: 400,
            });
          const size = Number(edit.size ?? 14);
          if (!Number.isFinite(size) || size < 1 || size > 200)
            throw new ProxyError(
              "INVALID_EDIT",
              "文字大小须在 1 至 200 之间。",
              { status: 400 },
            );
          if (/[^\x20-\x7e\n]/.test(edit.text)) {
            const measure = createCanvas(1, 1).getContext("2d");
            measure.font = `${size * 2}px "Microsoft YaHei", "PingFang SC", sans-serif`;
            const width = Math.ceil(
              measure.measureText(edit.text).width + size * 2,
            );
            const canvas = createCanvas(
              Math.min(width, 20000),
              Math.ceil(size * 3),
            );
            const context = canvas.getContext("2d");
            context.font = measure.font;
            context.fillStyle = "#000000";
            context.textBaseline = "top";
            context.fillText(edit.text, 0, 0);
            const image = await document.embedPng(await canvas.encode("png"));
            page.drawImage(image, {
              x,
              y,
              width: image.width / 2,
              height: image.height / 2,
            });
          } else
            page.drawText(edit.text, { x, y, size, font, color: rgb(0, 0, 0) });
        } else if (edit.type === "rectangle")
          page.drawRectangle({
            x,
            y,
            width: Number(edit.width),
            height: Number(edit.height),
            color: rgb(1, 1, 1),
          });
        else
          throw new ProxyError(
            "INVALID_EDIT",
            "Supported edit types are text, rectangle and rotate.",
            { status: 400 },
          );
      }
      return {
        artifacts: [await save(document, options.name ?? "edited.pdf")],
      };
    }
    const result = await PDFDocument.create();
    for (const page of await result.copyPages(
      document,
      selectedPages(options.pages, document.getPageCount()),
    )) {
      if (options.rotation !== undefined)
        page.setRotation(degrees(Number(options.rotation)));
      result.addPage(page);
    }
    return {
      artifacts: [
        await save(
          result,
          options.name ??
            (toolId === "pdf_page_reflow" ? "reordered.pdf" : "extracted.pdf"),
        ),
      ],
    };
  }

  async images(toolId, inputs, options = {}) {
    const buffers = await Promise.all(
      inputs.map((input) =>
        this.artifacts.readBuffer(input.id, 50 * 1024 * 1024),
      ),
    );
    if (toolId === "image_to_pdf") {
      const pdf = await PDFDocument.create();
      for (const buffer of buffers) {
        const png = await sharp(buffer, { limitInputPixels: 40_000_000 })
          .rotate()
          .png()
          .toBuffer();
        const image = await pdf.embedPng(png);
        const page = pdf.addPage([image.width, image.height]);
        page.drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });
      }
      return {
        artifacts: [
          await this.artifacts.putBuffer(
            await pdf.save(),
            options.name ?? "images.pdf",
            "application/pdf",
          ),
        ],
      };
    }
    if (toolId === "image_compress") {
      const quality = options.quality ?? 75;
      if (!Number.isInteger(quality) || quality < 1 || quality > 100)
        throw new ProxyError(
          "INVALID_QUALITY",
          "Image quality must be between 1 and 100.",
          { status: 400 },
        );
      const outputs = [];
      for (const [index, buffer] of buffers.entries()) {
        const pipeline = sharp(buffer, {
          limitInputPixels: 40_000_000,
        }).rotate();
        if (options.width !== undefined)
          pipeline.resize({
            width: Number(options.width),
            withoutEnlargement: true,
          });
        const bytes =
          options.format === "webp"
            ? await pipeline.webp({ quality }).toBuffer()
            : await pipeline.jpeg({ quality }).toBuffer();
        outputs.push(
          await this.artifacts.putBuffer(
            bytes,
            `compressed-${index + 1}.${options.format === "webp" ? "webp" : "jpg"}`,
            options.format === "webp" ? "image/webp" : "image/jpeg",
          ),
        );
      }
      return { artifacts: outputs };
    }
    const prepared = await Promise.all(
      buffers.map(async (buffer) => {
        const bytes = await sharp(buffer, { limitInputPixels: 40_000_000 })
          .rotate()
          .png()
          .toBuffer();
        return { bytes, ...(await sharp(bytes).metadata()) };
      }),
    );
    const horizontal = options.direction === "horizontal";
    const width = horizontal
      ? prepared.reduce((sum, image) => sum + image.width, 0)
      : Math.max(...prepared.map((image) => image.width));
    const height = horizontal
      ? Math.max(...prepared.map((image) => image.height))
      : prepared.reduce((sum, image) => sum + image.height, 0);
    if (width * height > 40_000_000)
      throw new ProxyError(
        "IMAGE_TOO_LARGE",
        "The combined image exceeds 40 million pixels.",
        { status: 413 },
      );
    let offset = 0;
    const layers = prepared.map((image) => {
      const layer = {
        input: image.bytes,
        left: horizontal ? offset : 0,
        top: horizontal ? 0 : offset,
      };
      offset += horizontal ? image.width : image.height;
      return layer;
    });
    const bytes = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: options.background ?? "#ffffff",
      },
    })
      .composite(layers)
      .png()
      .toBuffer();
    return {
      artifacts: [
        await this.artifacts.putBuffer(
          bytes,
          options.name ?? "stitched.png",
          "image/png",
        ),
      ],
    };
  }

  async pdfJs(bytes) {
    if (!Buffer.from(bytes).subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new ProxyError('INVALID_PDF', '输入文件不是可识别的 PDF，请核对下载结果和文件格式。', { status: 422 });
    globalThis.DOMMatrix ??= DOMMatrix;
    globalThis.ImageData ??= ImageData;
    globalThis.Path2D ??= Path2D;
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;
  }

  async renderPdf(input, options = {}) {
    const document = await this.pdfJs(
      await this.artifacts.readBuffer(input.id),
    );
    const outputs = [];
    const scale = Number(options.scale ?? 1.5);
    if (!Number.isFinite(scale) || scale < 0.25 || scale > 4)
      throw new ProxyError(
        "INVALID_SCALE",
        "PDF rendering scale must be between 0.25 and 4.",
        { status: 400 },
      );
    try {
      for (const index of selectedPages(options.pages, document.numPages)) {
        const page = await document.getPage(index + 1);
        const viewport = page.getViewport({ scale });
        if (viewport.width * viewport.height > 40_000_000)
          throw new ProxyError(
            "IMAGE_TOO_LARGE",
            "The rendered page exceeds 40 million pixels.",
            { status: 413 },
          );
        const canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvas,
          canvasContext: canvas.getContext("2d"),
          viewport,
        }).promise;
        outputs.push(
          await this.artifacts.putBuffer(
            await canvas.encode("png"),
            `page-${index + 1}.png`,
            "image/png",
          ),
        );
        page.cleanup();
      }
      return { artifacts: outputs };
    } finally {
      await document.loadingTask.destroy();
    }
  }

  async extractText(input) {
    const document = await this.pdfJs(
      await this.artifacts.readBuffer(input.id),
    );
    const pages = [];
    try {
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => item.str ?? "").join(" "));
        page.cleanup();
      }
    } finally {
      await document.loadingTask.destroy();
    }
    const text = pages.join("\n\n");
    if (!text.trim())
      throw new ProxyError(
        "OCR_REQUIRED",
        "This PDF has no embedded text. Use cloud OCR conversion or the native OCR editor.",
        { status: 422 },
      );
    return {
      text,
      artifacts: [
        await this.artifacts.putBuffer(
          Buffer.from(text),
          "extracted.txt",
          "text/plain; charset=utf-8",
        ),
      ],
    };
  }
}
