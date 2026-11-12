// The rows of a still recording (stills.jsonl): one row per planned still of a recording, written by the host in the order of
// the plan (docs/spec/endpoint.md, diagnostics.capture.stop).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A raw mach time of a still row, as milliseconds on the clock of the recording (sp_capture_clock). */
const machMs = (ticks, numerator, denominator) => Number(BigInt(ticks) * BigInt(numerator) / BigInt(denominator)) / 1e6;

/**
 * The rows of the still recording file `path` (stills.jsonl), one per planned still in the order of the plan, with the times of
 * each still in ms on the clock of the recording: `planned`, `requested` and `completed` (null for a still that was not
 * requested), `gap` (the requested gap), `outcome`, `error`, `frame` (the path of its frame file, null for a still that wrote
 * none), `windows` and `late`, whether it was requested later than one gap after its plan.
 */
export function readStills(path) {
  const directory = dirname(path);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
    const row = JSON.parse(line);
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

