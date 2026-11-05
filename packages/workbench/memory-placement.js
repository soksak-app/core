/**
 * Classifies a placement after startup memory state is available, without holding an undrawn preparation. start gives the
 * candidates with the start values of their views, and it runs before the readiness wait: an operation during the wait can
 * close a tab of the candidates, which ends its origin, so the start values are those of the commit (docs/spec/projects.md#tab-origin).
 */
export async function memoryPlacement(record, candidates, { ready, saver, observe, start }) {
  if (!record || typeof record !== "object" || typeof record.drawn !== "boolean" || !Array.isArray(record.surfaces)
      || !Array.isArray(candidates) || !ready || typeof saver?.place !== "function" || typeof saver?.classify !== "function" || typeof observe !== "function"
      || typeof start !== "function") {
    throw new TypeError("memory placement requires a drawn state, its surfaces, candidates, readiness, saver, observer, and start values");
  }
  const started = start(candidates);
  if (record.drawn) await ready;
  observe(record, started);
  // Only a drawn record has every seat, and a preparation can leave out a shown view (docs/spec/plugins.md#memory-saver).
  if (record.drawn) saver.classify();
  const placement = saver.place(started);
  // A hidden section keeps its slot, so the seat of an unloaded section stands in the record, which the request of the host must hold.
  const unloaded = new Set(placement.unload);
  record.surfaces = record.surfaces.filter(({ id }) => !unloaded.has(id));
  return placement;
}
