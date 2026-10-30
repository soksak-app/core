// Measures the recorded frames of a window resize and keeps the measurements as run evidence (e2e/resize.test.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A frame in which the margin between the right and bottom edges of the layout and the window edges differs from the reference by more than this amount (pt) is a frame in which the layout is behind the window.
 * When the window grows, the margin widens; when it shrinks, the previous layout is clipped outside the window and the margin disappears.
 */
export const LAG = 12;

/** Time (ms) from the recording start to the last behind frame that the layout may take (docs/spec/native-surfaces.md#acceptance-criteria). */
export const CATCH_UP = 150;

/** Brightness darker than the card border and the glyphs. The window background and the empty area are darker than this. */
const BRIGHT = 70;

/**
 * Measures in window points the window size and the rightmost column and the lowest row that hold a bright pixel in the frame.
 * The buffer is fixed at the recording start size, and a grown window is stored reduced by contentScale.
 */
export function measureFrame(frame) {
  const ratio = frame.contentScale * frame.scale;
  const width = Math.floor(frame.content.width * frame.scale);
  const height = Math.floor(frame.content.height * frame.scale);
  const bright = (x, y) => {
    const i = y * frame.stride + x * 4;
    return Math.max(frame.data[i], frame.data[i + 1], frame.data[i + 2]) > BRIGHT;
  };
  let right = -1;
  for (let x = width - 1; x >= 0 && right < 0; x--) {
    for (let y = 0; y < height; y++) if (bright(x, y)) { right = x; break; }
  }
  let bottom = -1;
  for (let y = height - 1; y >= 0 && bottom < 0; y--) {
    for (let x = 0; x < width; x++) if (bright(x, y)) { bottom = y; break; }
  }
  return {
    time: frame.time,
    window: { width: frame.content.width / frame.contentScale, height: frame.content.height / frame.contentScale },
    gap: { x: frame.content.width / frame.contentScale - (right + 1) / ratio,
      y: frame.content.height / frame.contentScale - (bottom + 1) / ratio },
  };
}

/**
 * Marks each measured frame whose gap differs from the gap of the first frame by more than LAG, and returns the time (ms) from
 * the first frame to the last behind frame as `took`, 0 when no frame is behind.
 */
export function judgeFrames(measured) {
  if (measured.length === 0) return { behind: [], took: 0 };
  const [first] = measured;
  const behind = measured.map((m) => Math.abs(m.gap.x - first.gap.x) > LAG || Math.abs(m.gap.y - first.gap.y) > LAG);
  const last = behind.lastIndexOf(true);
  return { behind, took: last < 0 ? 0 : measured[last].time - first.time };
}

/** The time (ms on the frame clock) of an event-log line; the frame clock and `mono_ns` read the same monotonic clock. */
function lineTime(line) {
  if (!Number.isFinite(line?.mono_ns)) throw new Error(`${line?.event} has no finite mono_ns: ${JSON.stringify(line)}`);
  return line.mono_ns / 1e6;
}

/**
 * The stages of the layout that caught up with the window after a resize. `measured` are the measured frames, `layouts` the
 * layout transactions of diagnostics.capture.stop and `events` the event-log lines of the gesture. The layout that caught up is
 * the last transaction committed at or before the first frame after the last behind frame (`caught`). The result names the last
 * window resize event before that transaction began (`resized`), its stages, the root-view joins of its ticket from the
 * `host.trace.view.presentation-join` rows, the view whose join presented last before the commit (`heldBy`), and the host stall
 * records between the first frame and `caught`. It is null when no frame is behind the window.
 */
export function lagStages({ measured, layouts, events }) {
  const { behind } = judgeFrames(measured);
  const last = behind.lastIndexOf(true);
  if (last < 0) return null;
  const times = events.map((line) => ({ line, time: lineTime(line) }));
  const caught = measured[last + 1]?.time ?? null;
  const settled = layouts.filter((layout) => layout.committed !== null && (caught === null || layout.committed <= caught))
    .sort((a, b) => a.committed - b.committed).at(-1) ?? null;
  const resizes = times.filter(({ line, time }) => line.event === "host.window.event" && line.fields?.kind === "resize"
    && (settled === null || time <= settled.begun));
  const joins = new Map();
  for (const { line, time } of times) {
    if (settled === null || line.event !== "host.trace.view.presentation-join" || line.fields.ticket !== settled.ticket) continue;
    const { surface, generation, phase } = line.fields;
    const join = joins.get(surface) ?? { surface, generation, requested: null, presented: null };
    if (phase === "requested") join.requested = time;
    if (phase === "presented") join.presented = time;
    joins.set(surface, join);
  }
  const presented = [...joins.values()].filter((join) => join.presented !== null).sort((a, b) => a.presented - b.presented);
  const end = caught ?? measured.at(-1).time;
  return {
    caught,
    resized: resizes.at(-1)?.time ?? null,
    ticket: settled?.ticket ?? null,
    begun: settled?.begun ?? null,
    requested: settled?.requested ?? null,
    presented: settled?.presented ?? null,
    committed: settled?.committed ?? null,
    joins: [...joins.values()],
    heldBy: presented.at(-1)?.surface ?? null,
    stalls: times.filter(({ line, time }) => line.event.startsWith("host.stall") && time >= measured[0].time && time <= end)
      .map(({ line, time }) => ({ time, event: line.event })),
  };
}

/**
 * The evidence of one resize gesture: each measured frame with its time, window size, gaps and behind flag, the display time
 * of the layout, the layout transactions that diagnostics.capture.stop returned and the stages of lagStages (ms on the frame clock).
 */
export function frameEvidence({ gesture, displayed, measured, layouts, stages = null }) {
  const { behind } = judgeFrames(measured);
  return {
    gesture,
    lag: LAG,
    catchUp: CATCH_UP,
    displayed,
    frames: measured.map((m, i) => ({ time: m.time, window: m.window, gap: m.gap, behind: behind[i] })),
    layouts,
    stages,
  };
}

/** Writes the evidence of one gesture to `resize-frames-<app>-<gesture>.json` in the run folder and returns the file path. */
export function writeEvidence(runFolder, app, gesture, evidence) {
  if (typeof runFolder !== "string" || runFolder.length === 0) {
    throw new Error("SOKSAK_RUN_FOLDER is required to keep the resize frames");
  }
  mkdirSync(runFolder, { recursive: true });
  const path = join(runFolder, `resize-frames-${app}-${gesture}.json`);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
}
