import { byteLength } from "@soksak/plugin-api/bounded-json.js";

/** Replaces full view declarations with indexes in a request-local host wire table. */
export function surfaceSyncRequestWithDeclarationTable(request) {
  if (!request || typeof request !== "object" || !Array.isArray(request.surfaces)) {
    throw new TypeError("surface sync request requires a surfaces array");
  }
  const declarationTable = [];
  const indexes = new Map();
  const surfaces = request.surfaces.map((surface) => {
    if (surface?.composition?.kind !== "view" || !surface.start
        || !Object.hasOwn(surface.start, "declarations")) return surface;
    if (surface.start.declarations === null || typeof surface.start.declarations !== "object"
        || Array.isArray(surface.start.declarations)) {
      throw new TypeError(`surface ${surface.id} declarations are not an object`);
    }
    let serialized;
    try {
      serialized = JSON.stringify(surface.start.declarations, (_key, value) => {
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new TypeError(`surface ${surface.id} declarations contain a non-finite number`);
        }
        return value;
      });
    } catch (error) {
      throw new TypeError(`surface ${surface.id} declarations are not JSON: ${error.message}`);
    }
    if (serialized === undefined) throw new TypeError(`surface ${surface.id} declarations are not JSON`);
    let entry = indexes.get(serialized);
    if (entry === undefined) {
      const declaration = JSON.parse(serialized);
      if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) {
        throw new TypeError(`surface ${surface.id} declarations serialize to a non-object`);
      }
      entry = { index: declarationTable.length, serialized, references: 0 };
      indexes.set(serialized, entry);
      declarationTable.push(declaration);
    }
    entry.references += 1;
    return { ...surface, start: { ...surface.start, declarations: entry.index } };
  });
  const normalized = { ...request, declarations: declarationTable, surfaces };
  const declarationBytes = () => {
    let declarationInlineBytes = 0;
    let declarationTableBytes = 2;
    for (const { index, serialized, references } of indexes.values()) {
      const bytes = byteLength(serialized);
      declarationInlineBytes += bytes * references;
      declarationTableBytes += bytes + (index === 0 ? 0 : 1);
    }
    return { declarationInlineBytes, declarationTableBytes };
  };
  return { request: normalized, declarationBytes };
}
