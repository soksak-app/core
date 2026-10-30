// The phases of the window reload stress, read from the event log of the application. Each request that a client sends to the
// endpoint is the event `host.endpoint.call` with its method, its params as received and its `micros` from the receipt of the
// request to its result (docs/spec/logging.md#entrances). A `command.run` request names its command in its params, so the phase
// of that request is the command name.
import { readEvents } from "@soksak/window-check/event-log.mjs";

/**
 * The phases written after offsets in the host event logs, in the order of seq, and the new positions. A `command.run` phase is
 * named by its command; any other phase is named by its method. An event whose params are truncated names no phase, so it is
 * refused with its seq.
 */
export function readPhases(configDir, offsets) {
  const { events, offsets: next } = readEvents(configDir, offsets);
  const phases = events.filter((event) => event.event === "host.endpoint.call" && !READER_METHODS.has(event.fields?.name)).map(phaseOf);
  return { phases, offsets: next };
}

// The requests that the reading of the phases sends: they are not phases of the check.
const READER_METHODS = new Set(["diagnostics.log.flush"]);

function phaseOf(event) {
  const { name, args, micros, ok, error, truncated } = event.fields ?? {};
  if (typeof name !== "string") throw new Error(`seq ${event.seq}: the host.endpoint.call event has no method name`);
  if (!Number.isInteger(micros) || micros < 0) throw new Error(`seq ${event.seq}: the host.endpoint.call event of ${name} has no micros`);
  if (typeof ok !== "boolean") throw new Error(`seq ${event.seq}: the host.endpoint.call event of ${name} has no ok`);
  let phase = name;
  if (name === "command.run") {
    if (truncated === true) throw new Error(`seq ${event.seq}: the params of ${name} are truncated, so the command is unknown`);
    let params;
    try {
      params = JSON.parse(args);
    } catch (parseError) {
      throw new Error(`seq ${event.seq}: the params of ${name} are not JSON: ${parseError.message}`);
    }
    if (typeof params?.name !== "string") throw new Error(`seq ${event.seq}: the params of ${name} name no command`);
    phase = params.name;
  }
  return { seq: event.seq, phase, micros, ok, error: typeof error === "string" ? error : null };
}

/** The phase with the greatest micros; the first of equal ones. Null when no phase was read. */
export function slowestPhase(phases) {
  let slowest = null;
  for (const phase of phases) if (slowest === null || phase.micros > slowest.micros) slowest = phase;
  return slowest;
}

/**
 * The error of a failed check with the slowest phase named in its message: `<message>; slowest phase <phase> took <ms> ms`, or
 * `<message>; no host.endpoint.call phase was read` when the check read none. The original error is the cause.
 */
export function failureWithSlowestPhase(error, phases) {
  const slowest = slowestPhase(phases);
  const named = slowest === null
    ? "no host.endpoint.call phase was read"
    : `slowest phase ${slowest.phase} took ${Math.round(slowest.micros / 1000)} ms`;
  return new Error(`${error.message}; ${named}`, { cause: error });
}
