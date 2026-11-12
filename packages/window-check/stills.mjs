// The rows of a still recording (stills.jsonl): one row per planned still of a recording, written by the host in the order of
// the plan (docs/spec/endpoint.md, diagnostics.capture.stop).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A raw mach time of a still row, as milliseconds on the clock of the recording (sp_capture_clock). */
const machMs = (ticks, numerator, denominator) => Number(BigInt(ticks) * BigInt(numerator) / BigInt(denominator)) / 1e6;

const OUTCOMES = ["written", "failed", "not-requested"];
const DECIMAL = /^\d+$/;

/**
 * Checks row `row` at place `place` of the still recording `path` against its own fields and the timebase of the first row
 * `first`: a known outcome, exact decimal mach times, a request time exactly for a requested still, a completion time and a
 * window list for a written still and for a failed one whose windows were taken (a failed still whose windows could not be
 * taken has no completion time and the window list []), a request no earlier than the plan and a completion no earlier than the request, the frame of its index exactly for a
 * written still, an error exactly for a failed still, a positive gap and a positive timebase equal to the first row's.
 */
function requireStillRow(row, place, path, first) {
  const fail = (what) => { throw new Error(`still row ${place} of ${path} ${what}`); };
  if (!OUTCOMES.includes(row.outcome)) fail(`has the outcome ${JSON.stringify(row.outcome)}, not one of ${OUTCOMES.join(", ")}`);
  const exact = (name, value) => {
    if (!(typeof value === "string" && DECIMAL.test(value))) {
      fail(`has the ${name} time ${JSON.stringify(value)}, not an exact decimal mach time`);
    }
  };
  exact("planned", row.planned);
  const requested = row.outcome !== "not-requested";
  // A failed still whose windows could not be taken has no completion time (docs/spec/diagnostics.md, stills.jsonl).
  const taken = row.outcome === "written" || (row.outcome === "failed" && row.completed !== null);
  for (const name of ["requested", "completed"]) {
    const owed = name === "requested" ? requested : taken;
    if (owed && row[name] === null) fail(`is ${row.outcome} without its ${name} time`);
    if (!requested && row[name] !== null) fail(`is not-requested with a ${name} time`);
    if (row[name] !== null) exact(name, row[name]);
  }
  const { machTimebaseNumerator: numerator, machTimebaseDenominator: denominator } = row;
  if (!(Number.isSafeInteger(numerator) && numerator > 0 && Number.isSafeInteger(denominator) && denominator > 0)) {
    fail(`has the mach timebase ${numerator}/${denominator}, not positive integers`);
  }
  if (numerator !== first.machTimebaseNumerator || denominator !== first.machTimebaseDenominator) {
    fail(`has the mach timebase ${numerator}/${denominator}, not the ${first.machTimebaseNumerator}/` +
      `${first.machTimebaseDenominator} of the first row`);
  }
  if (requested && BigInt(row.requested) < BigInt(row.planned)) fail("was requested before its planned time");
  if (taken && BigInt(row.completed) < BigInt(row.requested)) fail("completed before its request");
  const frame = `frame-${String(row.index).padStart(4, "0")}.bgra`;
  if (row.outcome === "written" && row.frame !== frame) fail(`names the frame ${JSON.stringify(row.frame)}, not ${frame}`);
  if (row.outcome !== "written" && row.frame !== null) fail(`is ${row.outcome} and names the frame ${JSON.stringify(row.frame)}`);
  if (row.outcome === "failed" && !(typeof row.error === "string" && row.error.length > 0)) fail("failed without its error");
  if (row.outcome !== "failed" && row.error !== null) fail(`is ${row.outcome} with the error ${JSON.stringify(row.error)}`);
  if (taken && !(Array.isArray(row.windows) && row.windows.length > 0
    && row.windows.every((window) => Number.isSafeInteger(window) && window > 0))) {
    fail(`has the window list ${JSON.stringify(row.windows)}, not window numbers`);
  }
  if (!requested && row.windows !== null) fail("is not-requested with a window list");
  if (requested && !taken && !(Array.isArray(row.windows) && row.windows.length === 0)) {
    fail(`failed before its windows were taken and has the window list ${JSON.stringify(row.windows)}, not []`);
  }
  if (!(Number.isFinite(row.requestedGap) && row.requestedGap > 0)) {
    fail(`has the gap ${JSON.stringify(row.requestedGap)}, not a positive number of ms`);
  }
}

/**
 * The rows of the still recording file `path` (stills.jsonl), one per planned still in the order of the plan, with the times of
 * each still in ms on the clock of the recording: `planned`, `requested` and `completed` (null for a still that was not
 * requested), `gap` (the requested gap), `outcome`, `error`, `frame` (the path of its frame file, null for a still that wrote
 * none), `windows` and `late`, whether it was requested later than one gap after its plan. A row whose fields contradict each
 * other or its outcome is refused (requireStillRow).
 */
export function readStills(path) {
  const directory = dirname(path);
  const raw = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return raw.map((row, place) => {
    requireStillRow(row, place, path, raw[0]);
    const ms = (ticks) => ticks === null ? null : machMs(ticks, row.machTimebaseNumerator, row.machTimebaseDenominator);
    const planned = ms(row.planned);
    const requested = ms(row.requested);
    return { index: row.index, planned, requested, completed: ms(row.completed), gap: row.requestedGap, outcome: row.outcome,
      error: row.error, frame: row.frame === null ? null : join(directory, row.frame), windows: row.windows,
      late: requested !== null && requested - planned > row.requestedGap };
  });
}

/**
 * The rows of `rows` (readStills) that the recording lost among the stills planned from `from` to before `to` (ms): each still
 * that wrote no frame or that was requested later than one gap after its plan. The stills after the last requested one were not
 * requested because the recording stopped: they are its end, not a loss.
 */
export function lostStills(rows, from, to) {
  const stoppedAt = rows.findLastIndex((row) => row.requested !== null) + 1;
  return rows.slice(0, stoppedAt).filter((row) => (row.outcome !== "written" || row.late) && row.planned >= from
    && row.planned < to);
}

/** One lost still row, told by its index, its plan and what lost it. */
export const toldStill = (row) => `still ${row.index} planned at ${row.planned.toFixed(1)}ms ` + (row.outcome === "not-requested"
  ? "was not requested"
  : row.outcome === "failed" ? `failed (${row.error})` : `was requested ${(row.requested - row.planned).toFixed(1)}ms late`);


/**
 * Requires that the recording lost none of the stills `rows` (readStills) planned from `from` to before `to` (ms, the whole
 * recording by default), for a judgment of `what` that looks at every still of that time: it cannot see what a lost still showed.
 */
export function requireNoLostStills(rows, what, { from = -Infinity, to = Infinity } = {}) {
  const lost = lostStills(rows, from, to).map(toldStill);
  if (lost.length > 0) throw new Error(`the recording lost ${lost.length} stills of ${what}: ${lost.join(", ")}`);
}
