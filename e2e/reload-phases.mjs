// The phases of the window reload stress, timed by the check itself. Each request that the stress sends through a phased session is
// one phase: a command is named by its command, a read of a status by `status <name>`, a wait for a status by `until <name>` and the
// wait for the presentation by `host.window.presented`. Its time is the time from the send of the request to its answer, read with
// the monotonic clock of the check, so no event class of the application is stored for it.

/** The time from `start` (process.hrtime.bigint) to now in whole microseconds. */
function microsSince(start) {
  return Number((process.hrtime.bigint() - start) / 1000n);
}

/**
 * Sends one request through `send`, which returns its answer, and passes its phase `{phase, micros, ok, error}` to `record` when it
 * ends: `ok` is false and `error` the message when the request failed. The answer or the error of the request is returned unchanged.
 */
export async function timePhase(phase, send, record) {
  if (typeof phase !== "string" || phase === "") throw new TypeError(`a phase needs a name, not ${JSON.stringify(phase)}`);
  const start = process.hrtime.bigint();
  try {
    const answer = await send();
    record({ phase, micros: microsSince(start), ok: true, error: null });
    return answer;
  } catch (error) {
    record({ phase, micros: microsSince(start), ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * The requests of the session `s` that the stress sends, each timed as one phase that is passed to `record`: run, get, until and
 * presented take the arguments of the session methods of the same names.
 */
export function phasedSession(s, record) {
  return Object.freeze({
    run: (name, params) => timePhase(name, () => s.run(name, params), record),
    get: (name) => timePhase(`status ${name}`, () => s.get(name), record),
    until: (name, predicate, message) => timePhase(`until ${name}`, () => s.until(name, predicate, message), record),
    presented: () => timePhase("host.window.presented", () => s.presented(), record),
  });
}

/** The phase with the greatest micros; the first of equal ones. Null when no phase was timed. */
export function slowestPhase(phases) {
  let slowest = null;
  for (const phase of phases) if (slowest === null || phase.micros > slowest.micros) slowest = phase;
  return slowest;
}

/**
 * The error of a failed check with the slowest phase named in its message: `<message>; slowest phase <phase> took <ms> ms`, or
 * `<message>; no phase was timed` when the check timed none. The original error is the cause.
 */
export function failureWithSlowestPhase(error, phases) {
  const slowest = slowestPhase(phases);
  const named = slowest === null
    ? "no phase was timed"
    : `slowest phase ${slowest.phase} took ${Math.round(slowest.micros / 1000)} ms`;
  return new Error(`${error.message}; ${named}`, { cause: error });
}
