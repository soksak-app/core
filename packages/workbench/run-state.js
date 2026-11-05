// The state of a run: updates that continue, such as a divider drag. The compositor reports the two ends of a run here, and the
// code that holds work until the end of a run reads it without depending on the plane of the compositor.
let active = false;
const started = new Set();
const ended = new Set();

/** Records the current end of a run; a run that started or ended calls each listener of that edge. */
export function setRunActive(value) {
  if (value === active) return;
  active = value;
  for (const listener of [...(active ? started : ended)]) listener();
}

/** Whether a run continues now. */
export const runActive = () => active;

/** Registers fn for each start of a run and returns its off function. */
export function onRunStart(fn) {
  started.add(fn);
  return () => started.delete(fn);
}

/** Registers fn for each end of a run and returns its off function. */
export function onRunEnd(fn) {
  ended.add(fn);
  return () => ended.delete(fn);
}
