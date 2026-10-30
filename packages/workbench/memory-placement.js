/**
 * Classifies a placement after startup memory state is available, without holding an undrawn preparation. start gives the
 * candidates with the start values of their views, and it runs before the readiness wait: an operation during the wait can
 * close a tab of the candidates, which ends its origin, so the start values are those of the commit (docs/spec/projects.md#tab-origin).
 */
export async function memoryPlacement(record, candidates, { ready, saver, observe, start }) {
  if (!record || typeof record !== "object" || typeof record.drawn !== "boolean"
      || !Array.isArray(candidates) || !ready || typeof saver?.place !== "function" || typeof observe !== "function"
      || typeof start !== "function") {
    throw new TypeError("memory placement requires a drawn state, candidates, readiness, saver, observer, and start values");
  }
  const started = start(candidates);
  if (record.drawn) await ready;
  observe(record, started);
  return saver.place(started);
}
