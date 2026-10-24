/** Classifies a placement after startup memory state is available, without holding an undrawn preparation. */
export async function memoryPlacement(record, candidates, { ready, saver, observe }) {
  if (!record || typeof record !== "object" || typeof record.drawn !== "boolean"
      || !Array.isArray(candidates) || !ready || typeof saver?.place !== "function" || typeof observe !== "function") {
    throw new TypeError("memory placement requires a drawn state, candidates, readiness, saver, and observer");
  }
  if (record.drawn) await ready;
  observe(record, candidates);
  return saver.place(candidates);
}
