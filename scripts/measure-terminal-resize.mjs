// Reports, for each frame of a recorded divider drag between two terminal tabs, whether each terminal still shows the text that it showed
// before the drag (docs/operations/examples.md#terminal-resize-measurement). It opens a new project window of 1200 by 760 points, holds
// its covered drawing (diagnostics.window.draw-covered) so that its image regions draw while the windows of other applications cover it,
// opens one tab of the plugin PLUGIN and splits its card to the right with a second tab of PLUGIN. For each case of CASES it writes the
// command of the case into both tabs with `<plugin>.input`, waits until `<plugin>.screen` of each tab shows the line that the case ends
// with, and drags the divider between the two cards DISTANCE points to the left and back TIMES times over MS milliseconds each way with
// diagnostics.drag, which records the window at its refresh rate (`capture` of diagnostics.drag). The cases are:
//   prompt  the shell prints a line and waits at its prompt (`clear`, `echo`);
//   output  the shell prints 200 numbered lines and a line of 300 zeros, which wraps, and waits at its prompt;
//   alt     `less` shows a text file of the project folder on the alternate screen and redraws it at each size change.
// Each frame of the recording is read with readFrame of e2e/benchmark/cases/frame-pixels.mjs. The divider of a frame is found at the
// bottom padding row of the regions, where no text is drawn, as the run of the colour of the gap between the cards that the first
// frame shows there 2 points right of the left region (dividerOf); each terminal is the area between its fixed outer edge and that
// gap. A pixel is text when its red, green and blue differ from the background colour of the terminal, read in the first frame, by
// more than TEXT_DISTANCE in sum.
// For the prompt and output cases a frame misses the prompt of a terminal when its coloured text pixels, whose largest and smallest
// channel differ by more than COLOUR_SPREAD, are fewer than PROMPT_SHARE of those of the first frame: the prompt of the shell is the
// coloured text of these screens, and a raster of the last drawn size that the new size crops keeps more than that share of it. A shell
// whose prompt has no coloured text is reported as not judged. For the alt case, whose screen `less` fills at every width, a frame
// misses text when a band of pixel rows that showed text in the first frame is blank (fewer than BLANK_PER_POINT text pixels per square
// point of the scale); a band that shows other text after the program redrew it is no miss. For the prompt and output cases it also
// counts the frames that show the cursor off the prompt (cursorCell, cursorFrames): the cursor is the mark whose columns hold ink over
// the full height of a text row, and a frame whose cursor has no ink left of it and ink right of it on its row shows it on the first
// cell of the prompt. After the drag of the output case it
// compares the rows of zeros of each screen with those before the drag: a wrapped line that does not join into its rows at the
// original width is reported. It prints, per case and terminal, the frames, the frames in which the divider moved, the frames that
// miss text with their indexes and the comparison, and the folder of each recording, which stays in the logs folder of the
// configuration directory. A recording with few divider moves holds few presented frames of the gesture, and its judgment covers only
// those. It closes the project window afterwards and removes the project folder. Every error is printed
// to stderr, and the exit status is 1 when an error occurred. `make measure-terminal-resize` runs it.
//
// PLUGIN is an argument of the caller and has no default: the script names no plugin and measures a plugin of the installed environment
// that exposes `<plugin>.input` and `<plugin>.screen` and runs a shell with `clear`, `seq`, `printf` and `less`. It judges no value and
// gates nothing.
//
//   node scripts/measure-terminal-resize.mjs --config-dir DIR --plugin PLUGIN [--cases prompt,output,alt] [--distance 200] [--ms 900]
//     [--times 2] [--json]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { connect } from "@soksak/client";
import { drag, holdCovered, Session } from "@soksak/window-check/app.mjs";
import { frames as listFrames } from "@soksak/window-check/frame.mjs";
import { readFrame } from "../e2e/benchmark/cases/frame-pixels.mjs";
import { newWindow, openOnlyTab } from "./measure-app-usage.mjs";
import { screenText } from "./measure-terminal-redraw.mjs";

export const CASES = ["prompt", "output", "alt"];
/** The content size of the window of the measurement in points, the window of make measure-app-usage. */
const WINDOW_SIZE = Object.freeze({ width: 1200, height: 760 });
/** The sum of the red, green and blue differences from the background above which a pixel is text. */
export const TEXT_DISTANCE = 90;
/** The text pixels per square point below which a band that showed text is blank: anti-aliased edges of a neighbouring row, not a glyph. */
export const BLANK_PER_POINT = 5;
/** The share of the coloured text pixels of the first frame below which a frame misses the prompt. */
export const PROMPT_SHARE = 0.2;
/** The difference of the largest and the smallest channel above which a text pixel is coloured. */
export const COLOUR_SPREAD = 60;
/** The channel difference within which a pixel has the colour of the gap. */
const GAP_TOLERANCE = 8;
/** The shortest run of the gap colour, in points, that is the gap between the cards. */
const GAP_RUN = 4;
/** The file that the alt case shows, in the project folder. */
const TEXT_FILE = "resize-lines.txt";

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "config-dir": { type: "string" },
      plugin: { type: "string" },
      cases: { type: "string", default: CASES.join(",") },
      distance: { type: "string", default: "200" },
      ms: { type: "string", default: "900" },
      times: { type: "string", default: "2" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values["config-dir"] || !values.plugin) throw new Error("required options: --config-dir DIR --plugin PLUGIN");
  if (!isAbsolute(values["config-dir"])) throw new Error(`--config-dir must be an absolute path (${values["config-dir"]})`);
  const cases = values.cases.split(",");
  for (const name of cases) if (!CASES.includes(name)) throw new Error(`--cases holds ${name}; the cases are ${CASES.join(", ")}`);
  return {
    configDir: values["config-dir"], plugin: values.plugin, cases, distance: positiveInteger("--distance", values.distance),
    ms: positiveInteger("--ms", values.ms), times: positiveInteger("--times", values.times), json: values.json,
  };
}

function positiveInteger(name, text) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer (${text})`);
  return value;
}

/** The rows of a screen of `<plugin>.screen` as text without trailing spaces. */
export function screenRows(screen) {
  return screenText(screen).split("\n").map((row) => row.trimEnd());
}

/** The lengths of the rows of `rows` that hold only zeros, in their order. */
export function zeroRows(rows) {
  return rows.filter((row) => /^0+$/.test(row)).map((row) => row.length);
}

/**
 * The input of case `name` and the predicate on the rows of a screen that holds its end. The line that a shell case ends with is
 * printed by printf from two arguments, so the command line that the shell echoes does not hold it.
 */
export function caseInput(name, root) {
  if (name === "prompt") return { bytes: "clear; echo hello; printf '%s-%s\\n' resize prompt\n", shown: (rows) => rows.includes("resize-prompt") };
  if (name === "output") {
    return {
      bytes: "clear; seq 1 200; printf '%0300d\\n' 0; printf '%s-%s\\n' resize output\n",
      shown: (rows) => rows.includes("resize-output") && rows.some((row) => /^0+$/.test(row)),
    };
  }
  if (name === "alt") return { bytes: `clear; less ${JSON.stringify(join(root, TEXT_FILE))}\n`, shown: (rows) => rows[0]?.startsWith("line 1:") === true };
  throw new Error(`unknown case ${name}`);
}

/** The lines of the file that the alt case shows. */
export function textLines(count) {
  let text = "";
  for (let line = 1; line <= count; line++) text += `line ${line}: the quick brown fox jumps over the lazy dog ${line}\n`;
  return text;
}

/** The colour [r, g, b] of the frame at the window point (x, y). */
export function colourAt(frame, x, y) {
  const k = frame.scale * frame.contentScale;
  const px = Math.floor(frame.content.x * frame.scale + x * k);
  const py = Math.floor(frame.content.y * frame.scale + y * k);
  if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) throw new Error(`the window point ${x},${y} is outside the frame`);
  const at = py * frame.stride + px * 4;
  return [frame.data[at + 2], frame.data[at + 1], frame.data[at]];
}

/**
 * The gap between the two cards in `frame` on the line `y` between `from` and `to` (window points): the first run of at least GAP_RUN
 * points of the colour `gap`, as {start, end} in window points, or null when the line holds none.
 */
export function dividerOf(frame, { y, from, to, gap }) {
  const k = frame.scale * frame.contentScale;
  const py = Math.floor(frame.content.y * frame.scale + y * k);
  const x0 = Math.floor(frame.content.x * frame.scale + from * k);
  const x1 = Math.min(frame.width, Math.floor(frame.content.x * frame.scale + to * k));
  const point = (px) => (px - frame.content.x * frame.scale) / k;
  let start = null;
  for (let px = Math.max(0, x0); px < x1; px++) {
    const at = py * frame.stride + px * 4;
    const same = Math.abs(frame.data[at + 2] - gap[0]) <= GAP_TOLERANCE && Math.abs(frame.data[at + 1] - gap[1]) <= GAP_TOLERANCE &&
      Math.abs(frame.data[at] - gap[2]) <= GAP_TOLERANCE;
    if (same && start === null) start = px;
    if (!same && start !== null) {
      if (px - start >= GAP_RUN * k) return { start: point(start), end: point(px) };
      start = null;
    }
  }
  if (start !== null && x1 - start >= GAP_RUN * k) return { start: point(start), end: point(x1) };
  return null;
}

/**
 * The number of text pixels of each pixel row of `frame` from y0 to y1 between x0 and x1 (window points), as `profile`, and the number of
 * those that are coloured, as `coloured`.
 */
export function textProfile(frame, { x0, x1, y0, y1, background }) {
  const k = frame.scale * frame.contentScale;
  const px0 = Math.max(0, Math.floor(frame.content.x * frame.scale + x0 * k));
  const px1 = Math.min(frame.width, Math.floor(frame.content.x * frame.scale + x1 * k));
  const py0 = Math.max(0, Math.floor(frame.content.y * frame.scale + y0 * k));
  const py1 = Math.min(frame.height, Math.floor(frame.content.y * frame.scale + y1 * k));
  const profile = [];
  let coloured = 0;
  for (let py = py0; py < py1; py++) {
    let count = 0;
    const row = py * frame.stride;
    for (let px = px0; px < px1; px++) {
      const at = row + px * 4;
      const distance = Math.abs(frame.data[at + 2] - background[0]) + Math.abs(frame.data[at + 1] - background[1]) +
        Math.abs(frame.data[at] - background[2]);
      if (distance <= TEXT_DISTANCE) continue;
      count++;
      const r = frame.data[at + 2], g = frame.data[at + 1], b = frame.data[at];
      if (Math.max(r, g, b) - Math.min(r, g, b) > COLOUR_SPREAD) coloured++;
    }
    profile.push(count);
  }
  return { profile, coloured };
}

/** The bands of pixel rows of `profile` that hold text: runs of rows with text, joined across gaps of fewer than `join` rows. */
export function textBands(profile, join) {
  const bands = [];
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] === 0) continue;
    const last = bands.at(-1);
    if (last && i - last.end < join) last.end = i + 1;
    else bands.push({ start: i, end: i + 1 });
  }
  return bands;
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

/** The sum of the red, green and blue differences from the background above which a pixel is ink of a glyph or of the cursor. */
export const CURSOR_DISTANCE = 300;
/** The share of the cursor height of the first frame that a column of the cursor holds as one vertical run of ink. */
export const CURSOR_HEIGHT_SHARE = 0.9;

/**
 * The cursor cell of the terminal in `span` of `frame`. A block or hollow cursor is the one mark of a terminal screen whose columns hold
 * ink over the full height of a text row; a glyph is shorter. `height` is the cursor height in pixels that the first frame showed, or
 * null for the first frame, whose tallest vertical run of ink is the cursor. Ink is a pixel farther than CURSOR_DISTANCE from the
 * background, which leaves out anti-aliased edges and the dim scrollbar. Returns {x0, x1, y0, y1, height, left, right} in pixels from
 * the top left of the span, where x0..x1 reaches from the first to the last column of the cursor, which are both edges of a hollow
 * cursor, and `left` and `right` are the ink of the pixel rows y0..y1 left of x0 and right of x1, or null when no column holds a run of
 * CURSOR_HEIGHT_SHARE of `height`, as in a frame that does not draw the cursor.
 */
export function cursorCell(frame, span, height) {
  const k = frame.scale * frame.contentScale;
  const px0 = Math.max(0, Math.floor(frame.content.x * frame.scale + span.x0 * k));
  const px1 = Math.min(frame.width, Math.floor(frame.content.x * frame.scale + span.x1 * k));
  const py0 = Math.max(0, Math.floor(frame.content.y * frame.scale + span.y0 * k));
  const py1 = Math.min(frame.height, Math.floor(frame.content.y * frame.scale + span.y1 * k));
  const ink = (px, py) => {
    const at = py * frame.stride + px * 4;
    return Math.abs(frame.data[at + 2] - span.background[0]) + Math.abs(frame.data[at + 1] - span.background[1]) +
      Math.abs(frame.data[at] - span.background[2]) > CURSOR_DISTANCE;
  };
  // The longest vertical run of ink of each column, with the pixel row where it starts.
  const runs = [];
  for (let px = px0; px < px1; px++) {
    let best = { length: 0, start: 0 };
    let start = null;
    for (let py = py0; py <= py1; py++) {
      if (py < py1 && ink(px, py)) {
        if (start === null) start = py;
        continue;
      }
      if (start !== null && py - start > best.length) best = { length: py - start, start };
      start = null;
    }
    runs.push(best);
  }
  const tallest = Math.max(0, ...runs.map((run) => run.length));
  const target = height ?? tallest;
  if (target === 0) return null;
  const column = runs.findIndex((run) => run.length >= CURSOR_HEIGHT_SHARE * target);
  if (column < 0) return null;
  let end = runs.length;
  while (runs[end - 1].length < CURSOR_HEIGHT_SHARE * target) end--;
  const y0 = runs[column].start;
  const y1 = y0 + runs[column].length;
  let left = 0;
  let right = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = px0; px < px0 + column; px++) if (ink(px, py)) left++;
    for (let px = px0 + end; px < px1; px++) if (ink(px, py)) right++;
  }
  return { x0: column, x1: end, y0: y0 - py0, y1: y1 - py0, height: runs[column].length, left, right };
}

/**
 * The frames of one terminal in case `name` that show the cursor off the prompt: `cells` holds the cursorCell of each frame, or null for
 * a frame without the divider or without a cursor. The shell leaves the cursor after its prompt: the row of the cursor holds the prompt
 * left of it, or nothing when the prompt fills the row above and the cursor wraps to the first cell. A frame whose cursor has no ink
 * left of it and ink right of it on its row shows the cursor on the first cell of the prompt, off the prompt. A frame without a found
 * cursor is counted in `unjudged`. The alt case and a first frame without a cursor are not judged. Returns
 * {judged, off, unjudged}.
 */
export function cursorFrames(name, cells) {
  if (name === "alt" || !cells[0]) return { judged: false, off: [], unjudged: 0 };
  const off = [];
  let unjudged = 0;
  cells.forEach((cell, index) => {
    if (cell === null) unjudged++;
    else if (cell.left === 0 && cell.right > 0) off.push(index);
  });
  return { judged: true, off, unjudged };
}

/**
 * The judgment of the frames of one terminal in case `name`: `counts` holds, for each frame, `{bands, coloured}`, the text pixels of each
 * band of the first frame and the coloured text pixels, or null for a frame whose divider was not found; `blank` is the count below which
 * a band is blank. Returns `{judged, missing}`, the indexes of the frames that miss text; `judged` is false for a prompt without
 * coloured text.
 */
export function missingFrames(name, counts, blank) {
  const first = counts.find((value) => value !== null);
  if (!first) throw new Error("no frame of the recording shows the divider");
  if (name !== "alt" && first.coloured < blank) return { judged: false, missing: [] };
  const missing = [];
  counts.forEach((value, index) => {
    if (value === null) return;
    const misses = name === "alt"
      ? value.bands.some((count, band) => first.bands[band] >= blank && count < blank)
      : value.coloured < PROMPT_SHARE * first.coloured;
    if (misses) missing.push(index);
  });
  return { judged: true, missing };
}

/**
 * Reads each frame of the recording in `folder` and returns the text pixel counts of the left and the right terminal per frame, by the
 * bands of the first frame, with their coloured text pixels, and `moves`, the number of frames whose divider stands elsewhere than in the
 * frame before: a window that presents few frames of the drag shows few moves, and its frames do not show the gesture. `regions` are the frames of the two image regions (window points) before the drag.
 */
export function measureRecording(folder, regions) {
  const files = listFrames(folder);
  if (files.length === 0) throw new Error(`the recording ${folder} holds no frame`);
  const [left, right] = regions;
  const y = left.y + left.height - 2;
  const first = readFrame(files[0]);
  const background = colourAt(first, left.x + 2, y);
  const gap = colourAt(first, left.x + left.width + 2, y);
  const line = { y, from: left.x + 10, to: right.x + right.width - 10, gap };
  const divider0 = dividerOf(first, line);
  if (!divider0) throw new Error(`the first frame of ${folder} shows no gap between the cards at y ${y}`);
  // The edges of the regions from the gap, as the first frame places them.
  const leftEdge = left.x + left.width - divider0.start;
  const rightEdge = right.x - divider0.end;
  const spans = (divider) => [
    { x0: left.x, x1: divider.start + leftEdge, y0: left.y, y1: left.y + left.height, background },
    { x0: divider.end + rightEdge, x1: right.x + right.width, y0: right.y, y1: right.y + right.height, background },
  ];
  const bands = spans(divider0).map((span) => textBands(textProfile(first, span).profile, 1));
  const counts = [[], []];
  const cells = [[], []];
  const cursorHeights = spans(divider0).map((span) => cursorCell(first, span, null)?.height ?? null);
  let lost = 0;
  let moves = 0;
  let previous = divider0.start;
  for (const file of files) {
    const frame = file === files[0] ? first : readFrame(file);
    const divider = dividerOf(frame, line);
    if (!divider) {
      lost++;
      counts[0].push(null);
      counts[1].push(null);
      cells[0].push(null);
      cells[1].push(null);
      continue;
    }
    if (divider.start !== previous) moves++;
    previous = divider.start;
    spans(divider).forEach((span, side) => {
      const { profile, coloured } = textProfile(frame, span);
      counts[side].push({ bands: bands[side].map((band) => sum(profile.slice(band.start, band.end))), coloured });
      cells[side].push(cursorHeights[side] === null ? null : cursorCell(frame, span, cursorHeights[side]));
    });
  }
  const k = first.scale * first.contentScale;
  return { frames: files.length, withoutDivider: lost, moves, bands: bands.map((list) => list.length), counts, cells, blank: BLANK_PER_POINT * k * k };
}

/** Opens the window and the two tabs of the measurement in a new project of `root`. */
async function prepareWindow(s, plugin, root) {
  const w = await newWindow(s);
  await holdCovered(w);
  const project = await w.run("core.project.open", { root });
  if (typeof project?.id !== "string") throw new Error(`core.project.open of ${root} answered no project id (${JSON.stringify(project)})`);
  await w.run("host.window.resize", WINDOW_SIZE);
  await w.until("host.window", (status) => status.content?.width === WINDOW_SIZE.width && status.content?.height === WINDOW_SIZE.height,
    `window ${w.window} did not reach a content of ${WINDOW_SIZE.width} by ${WINDOW_SIZE.height} points`);
  const first = await openOnlyTab(w, plugin);
  const second = await w.run("core.card.split", { card: first.card, side: "right", plugin });
  for (const tab of [first.tab, second.tab]) await w.registered(tab, [`command ${plugin}.input`, `status ${plugin}.screen`]);
  return { s: w, tabs: [first.tab, second.tab], cards: [first.card, second.card], project: project.id };
}

async function untilShown(s, plugin, tab, shown, what) {
  const screen = await s.until(`${plugin}.screen`, (value) => Array.isArray(value) && shown(screenRows(value)),
    `the tab ${tab} did not show ${what}`, { surface: tab });
  return screenRows(screen);
}

async function measureCase({ s, plugin, tabs, cards, root, name, distance, ms, times }) {
  const input = caseInput(name, root);
  for (const tab of tabs) await s.run(`${plugin}.input`, { bytes: input.bytes }, tab);
  const before = [];
  for (const tab of tabs) before.push(await untilShown(s, plugin, tab, input.shown, `the end of the ${name} case`));
  const grid = await s.get("core.grid");
  const card = grid.cards.find((item) => item.id === cards[0]);
  if (!card) throw new Error(`core.grid of window ${s.window} has no card ${cards[0]}`);
  const { regions } = await s.get("host.window");
  const frames = tabs.map((tab) => {
    const region = regions.find((item) => item.surface === tab);
    if (!region?.frame) throw new Error(`host.window of window ${s.window} has no region of ${tab}`);
    return region.frame;
  });
  const result = await drag(s, { axis: "x", line: card.c1, dx: -distance, dy: 0, ms, times }, { capture: true });
  const folder = result.frameDir ?? result.frames;
  if (!folder) throw new Error(`the drag of the ${name} case has no recording: ${s.recordingNotes.join("; ")}`);
  const notes = s.recordingNotes.splice(0);
  const after = [];
  for (const tab of tabs) after.push(await untilShown(s, plugin, tab, input.shown, `the end of the ${name} case after the drag`));
  if (name === "alt") {
    for (const tab of tabs) await s.run(`${plugin}.input`, { bytes: "q" }, tab);
    for (const tab of tabs) await untilShown(s, plugin, tab, (rows) => !rows[0]?.startsWith("line "), "the shell after less");
  }
  const measured = measureRecording(folder, frames);
  return {
    name, folder, notes, took: result.took, asked: result.asked, frames: measured.frames, withoutDivider: measured.withoutDivider,
    moves: measured.moves,
    terminals: tabs.map((tab, side) => ({
      tab, bands: measured.bands[side], ...missingFrames(name, measured.counts[side], measured.blank),
      cursor: cursorFrames(name, measured.cells[side]),
      zerosBefore: zeroRows(before[side]), zerosAfter: zeroRows(after[side]),
    })),
  };
}

async function measureResize({ configDir, plugin, cases, distance, ms, times }) {
  const client = await connect({ configDir });
  const root = mkdtempSync(join(tmpdir(), "terminal-resize-project-"));
  writeFileSync(join(root, TEXT_FILE), textLines(600));
  const s = new Session({ name: basename(configDir), configDir }, client);
  let prepared = null;
  const results = [];
  let failure = null;
  try {
    const windows = await client.request("windows.list");
    if (!Array.isArray(windows) || windows.length === 0) throw new Error(`${configDir} lists no window`);
    s.window = windows[0].window;
    prepared = await prepareWindow(s, plugin, root);
    for (const name of cases) results.push(await measureCase({ ...prepared, plugin, root, name, distance, ms, times }));
  } catch (error) {
    failure = error;
  }
  const cleanup = [];
  if (prepared !== null) {
    try {
      const { closed } = await prepared.s.run("core.project.close", { id: prepared.project });
      if (closed !== true) throw new Error(`core.project.close kept the project ${prepared.project} of the measurement (closed ${closed})`);
      await prepared.s.close();
      await s.until("host.windows", (list) => !list.some((entry) => entry.window === prepared.s.window), `window ${prepared.s.window} did not close`);
    } catch (error) {
      cleanup.push(error);
    }
  }
  client.close();
  rmSync(root, { recursive: true, force: true });
  const errors = [failure, ...cleanup].filter((error) => error !== null);
  if (errors.length > 1) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  if (errors.length === 1) throw errors[0];
  return { plugin, distance, ms, times, results };
}

export function formatReport({ plugin, distance, ms, times, results }) {
  const lines = [`${plugin}: divider ${distance} points left and back ${times} times, ${ms} ms each way`];
  for (const result of results) {
    lines.push(`${result.name}: ${result.frames} frames, ${result.moves} divider moves, ${result.withoutDivider} without the divider, drag ${result.took} ms of ${result.asked} ms; ${result.folder}`);
    for (const note of result.notes) lines.push(`  recording: ${note}`);
    result.terminals.forEach((terminal, side) => {
      const rejoined = JSON.stringify(terminal.zerosBefore) === JSON.stringify(terminal.zerosAfter);
      const judged = terminal.judged
        ? `${terminal.missing.length} frames miss text${terminal.missing.length > 0 ? ` (first ${terminal.missing.slice(0, 8).join(", ")})` : ""}`
        : "not judged (no coloured prompt)";
      const { cursor } = terminal;
      const cursorJudged = cursor.judged
        ? `${cursor.off.length} frames show the cursor off the prompt${cursor.off.length > 0 ? ` (first ${cursor.off.slice(0, 8).join(", ")})` : ""}, ${cursor.unjudged} not judged`
        : "cursor not judged";
      lines.push(`  ${side === 0 ? "left" : "right"} ${terminal.tab}: ${judged}, ${cursorJudged}, ${terminal.bands} text bands` +
        (result.name === "output" ? `, zero rows ${JSON.stringify(terminal.zerosBefore)} -> ${JSON.stringify(terminal.zerosAfter)}${rejoined ? "" : " NOT REJOINED"}` : ""));
    });
  }
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await measureResize(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
