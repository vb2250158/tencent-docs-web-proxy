import catalog from "./tool-catalog.json" with { type: "json" };
import { ProxyError } from "./errors.mjs";

const definitions = new Map(catalog.tools.map((tool) => [tool.id, tool]));

/** One public catalogue owns tool IDs, categories, labels and official entry points. */
export function getTool(id) {
  const tool = definitions.get(id);
  if (!tool)
    throw new ProxyError(
      "UNKNOWN_TOOL",
      "Use tools/list or GET /v1/tools to choose a supported toolbox item.",
      { status: 404 },
    );
  return structuredClone(tool);
}

export function listToolCatalog() {
  return structuredClone(catalog);
}
