// The state of a run: updates that continue, such as a divider drag. The compositor reports the two ends of a run here, and the
// code that holds work until the end of a run reads it without depending on the plane of the compositor.
let active = false;
const ended = new Set();

/** Records the current end of a run; a run that ended calls each listener. */
export function setRunActive(value) {
  if (value === active) return;
  active = value;
  if (!active) for (const listener of [...ended]) listener();
}

/** Whether a run continues now. */
export const runActive = () => active;

/** Registers fn for each end of a run and returns its off function. */
export function onRunEnd(fn) {
  ended.add(fn);
  return () => ended.delete(fn);
}
