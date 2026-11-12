// The rows of a still recording (stills.jsonl): one row per planned still of a recording, written by the host in the order of
// the plan (docs/spec/endpoint.md, diagnostics.capture.stop).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A raw mach time of a still row, as milliseconds on the clock of the recording (sp_capture_clock). */
const machMs = (ticks, numerator, denominator) => Number(BigInt(ticks) * BigInt(numerator) / BigInt(denominator)) / 1e6;

const OUTCOMES = ["written", "failed", "not-requested"];
const DECIMAL = /^\d+$/;
/** The file of the ICC profile of a colour space in a recording folder: color-<first 16 hex digits of its SHA-256>.icc. */
export const PROFILE_FILE = /^color-[0-9a-f]{16}\.icc$/;

/**
 * The stage times of a still row (docs/spec/diagnostics.md, stills.jsonl), each a raw mach time or null for a stage that did
 * not run: the processing of the still after its completion, the image match and the identity enqueue in it, and the write of
 * its frame. A written still ran each stage of WRITTEN_STAGES.
 */
const STAGES = ["writeStartTime", "writeCompleteTime", "imageMatchStartTime", "imageMatchCompleteTime",
  "identityDecodeEnqueueStartTime", "identityDecodeEnqueueCompleteTime", "writerEnqueuedTime", "writerStartTime", "writerCompleteTime"];
const WRITTEN_STAGES = ["writeStartTime", "writeCompleteTime", "imageMatchStartTime", "imageMatchCompleteTime", "writerEnqueuedTime",
  "writerStartTime", "writerCompleteTime"];
/** The stages that have both of their times or neither. */
const BRACKETS = [["writeStartTime", "writeCompleteTime"], ["imageMatchStartTime", "imageMatchCompleteTime"],
  ["identityDecodeEnqueueStartTime", "identityDecodeEnqueueCompleteTime"], ["writerStartTime", "writerCompleteTime"]];
/**
 * The order of the times of a still: the processing starts at or after its completion and holds the image match and the
 * identity enqueue, and the frame write is enqueued after the processing ends.
 */
const ORDER = [["completed", "writeStartTime"], ["writeStartTime", "imageMatchStartTime"], ["imageMatchStartTime", "imageMatchCompleteTime"],
  ["imageMatchCompleteTime", "writeCompleteTime"], ["writeStartTime", "identityDecodeEnqueueStartTime"],
  ["identityDecodeEnqueueStartTime", "identityDecodeEnqueueCompleteTime"], ["identityDecodeEnqueueCompleteTime", "writeCompleteTime"],
  ["writeCompleteTime", "writerEnqueuedTime"], ["writerEnqueuedTime", "writerStartTime"], ["writerStartTime", "writerCompleteTime"]];
/** The QR decoder runs after the still, so a still row holds none of its times (decoded-frames.jsonl does). */
const DECODE_TIMES = ["frameIdentityDecodeStartTime", "frameIdentityDecodeCompleteTime"];

/** Whether still row `row` (stills.jsonl) was requested more than one gap after its plan, on the raw mach clock of the row. */
const lateRow = (row) => row.requested !== null && Number(BigInt(row.requested) - BigInt(row.planned))
  > row.requestedGap * 1e6 * row.machTimebaseDenominator / row.machTimebaseNumerator;

/**
 * Checks row `row` at place `place` of the still recording `path` against its own fields and the timebase of the first row
 * `first`: a known outcome, exact decimal mach times, a request time exactly for a requested still, a completion time and a
 * window list for a written still and for a failed one whose windows were taken (a failed still whose windows could not be
 * taken has no completion time and the window list []), a request no earlier than the plan and a completion no earlier than the
 * request, the frame of its index exactly for a written still, an error exactly for a failed still, a positive gap, a positive
 * timebase equal to the first row's, and stage times (STAGES) that are exact decimal mach times or null, each stage of
 * WRITTEN_STAGES for a written still and none for a still that took no image, bracketed (BRACKETS) and in order (ORDER), with
 * no decode time (DECODE_TIMES), and the colour of its image: a colour space that is a name or null and a profile file
 * (PROFILE_FILE), which a written still names and a still that took no image does not.
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
  for (const name of STAGES) {
    if (!(row[name] === null || (typeof row[name] === "string" && DECIMAL.test(row[name])))) {
      fail(`has the ${name} time ${JSON.stringify(row[name])}, not an exact decimal mach time or null`);
    }
    if (!taken && row[name] !== null) fail(`took no image and has the ${name} time ${JSON.stringify(row[name])}`);
  }
  for (const name of DECODE_TIMES) {
    if (row[name] !== null) fail(`has the ${name} time ${JSON.stringify(row[name])}, which a still row does not hold`);
  }
  if (row.outcome === "written") {
    for (const name of WRITTEN_STAGES) if (row[name] === null) fail(`is written without its ${name} time`);
  }
  for (const [start, end] of BRACKETS) {
    if ((row[start] === null) !== (row[end] === null)) {
      const [held, missing] = row[start] === null ? [end, start] : [start, end];
      fail(`has the ${held} time without its ${missing} time`);
    }
  }
  for (const [earlier, later] of ORDER) {
    if (row[earlier] !== null && row[later] !== null && BigInt(row[later]) < BigInt(row[earlier])) {
      fail(`has its ${later} time before its ${earlier} time`);
    }
  }
  if (!(row.colorSpace === null || (typeof row.colorSpace === "string" && row.colorSpace.length > 0))) {
    fail(`has the colour space ${JSON.stringify(row.colorSpace)}, not a name or null`);
  }
  if (row.outcome === "written" && row.colorProfile === null) fail("is written without its colour profile");
  if (!(row.colorProfile === null || (typeof row.colorProfile === "string" && PROFILE_FILE.test(row.colorProfile)))) {
    fail(`has the colour profile ${JSON.stringify(row.colorProfile)}, not color-<16 hex digits>.icc`);
  }
  if (!taken) {
    if (row.colorSpace !== null) fail(`took no image and has the colour space ${JSON.stringify(row.colorSpace)}`);
    if (row.colorProfile !== null) fail(`took no image and has the colour profile ${JSON.stringify(row.colorProfile)}`);
  }
}

/** The rows of the still recording file `path` (stills.jsonl) as the host wrote them. */
const rawStills = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/**
 * The rows of the still recording file `path` (stills.jsonl), one per planned still in the order of the plan, with the times of
 * each still in ms on the clock of the recording: `planned`, `requested` and `completed` (null for a still that was not
 * requested), `gap` (the requested gap), `outcome`, `error`, `frame` (the path of its frame file, null for a still that wrote
 * none), `windows`, `late`, whether it was requested later than one gap after its plan, `colorSpace` and `colorProfile` (the
 * path of the ICC profile of its image, null for a still without one). A row whose fields contradict each
 * other or its outcome is refused (requireStillRow).
 */
export function readStills(path) {
  const directory = dirname(path);
  const raw = rawStills(path);
  return raw.map((row, place) => {
    requireStillRow(row, place, path, raw[0]);
    const ms = (ticks) => ticks === null ? null : machMs(ticks, row.machTimebaseNumerator, row.machTimebaseDenominator);
    const planned = ms(row.planned);
    const requested = ms(row.requested);
    return { index: row.index, planned, requested, completed: ms(row.completed), gap: row.requestedGap, outcome: row.outcome,
      error: row.error, frame: row.frame === null ? null : join(directory, row.frame), windows: row.windows, late: lateRow(row),
      colorSpace: row.colorSpace, colorProfile: row.colorProfile === null ? null : join(directory, row.colorProfile) };
  });
}

/**
 * The counts of the still recording file `path` (stills.jsonl, read by readStills) that its stop reply tells: `late`, the stills
 * requested more than one gap after their plan, and `longestGap`, the longest interval in ms between the request times of two
 * consecutive written stills (0 for fewer than two), each on the raw mach clock of the recording.
 */
export function stillCounts(path) {
  const raw = rawStills(path);
  const written = raw.filter((row) => row.outcome === "written");
  const longestGap = Math.max(0, ...written.slice(1).map((row, i) => Number(BigInt(row.requested) - BigInt(written[i].requested))
    * row.machTimebaseNumerator / row.machTimebaseDenominator / 1e6));
  return { late: raw.filter(lateRow).length, longestGap };
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

/**
 * Checks the decoded rows `decoded` of the frame identity of a recording (decoded-frames.jsonl, `what` names them) against its
 * still recording file `path` (stills.jsonl, read by readStills): each row names the still whose pixels it decoded by its index
 * and the exact decimal mach times of its request and completion, which are those of that still in the recording.
 */
export function requireDecodedStills(decoded, path, what) {
  const raw = rawStills(path);
  decoded.forEach((row, place) => {
    const fail = (told) => { throw new Error(`${what}: decoded row ${place} ${told}`); };
    if (!(Number.isSafeInteger(row.index) && row.index >= 0)) fail(`names the still ${JSON.stringify(row.index)}, not a still index`);
    for (const name of ["requested", "completed"]) {
      if (!(typeof row[name] === "string" && DECIMAL.test(row[name]))) {
        fail(`has the ${name} time ${JSON.stringify(row[name])}, not an exact decimal mach time`);
      }
    }
    const still = raw[row.index];
    if (!still) fail(`names still ${row.index}, which ${path} does not plan`);
    if (still.requested !== row.requested || still.completed !== row.completed) {
      fail(`names still ${row.index} requested at ${row.requested} and completed at ${row.completed}, and ${path} has it ` +
        `requested at ${still.requested} and completed at ${still.completed}`);
    }
  });
}
