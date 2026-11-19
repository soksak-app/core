// Reports the CPU time and the memory of each process of a running application while one terminal tab holds a growing amount of text
// (docs/operations/examples.md#terminal-text-measurement). It sets the trace state 0 (scripts/measure-trace.mjs), opens a new project
// window of 1200 by 760 points with one tab of the plugin PLUGIN, holds the covered drawing of that window
// (diagnostics.window.draw-covered), as the window checks do, so that its image region draws and its documents render while the
// windows of other applications cover it, and gives the image region of the tab the native keyboard of the virtual key window. For
// each amount of LINES, in increasing order, it writes the lines that the earlier amounts did not write into a file of the project
// folder (textLines), runs `cat` of that file in the tab with `<plugin>.input`, waits until `<plugin>.screen` shows the end line that
// the shell prints after it and ends that watch, because a watch of the screen relays every screen too. It then measures three
// intervals with measureApps of scripts/measure-app-usage.mjs:
//   idle    FRAMES display periods of the window, at the refresh rate that host.window reports right before the interval, without input;
//           the footprints are read after they settle (the G3 rule of scripts/footprints.mjs) before this interval;
//   keys    KEYS presses of `a` through input.key, each after the region presented the frame of the key before it; after the
//           interval Control-U clears the line of the shell;
//   redraw  FRAMES display periods while scripts/fixtures/status-redraw.mjs rewrites 20 rows at the bottom of the screen 30 times per
//           second, as an interactive program draws its status, divided by the frames that the region presented.
// It prints, for each amount and interval, the CPU time of each process, its CPU milliseconds per display period (idle), per key
// (keys) or per presented frame (redraw), the footprint of each process, the presented frames of the region, the occlusion of the
// window and the load of the machine that `top -l 1` reports at the start of the interval, so that a figure taken under the load of
// another program is marked. It closes the project window afterwards and removes the project folder. Every error is printed to
// stderr, and the exit status is 1 when an error occurred. `make measure-terminal-text` runs it.
//
// PLUGIN is an argument of the caller and has no default: the script names no plugin and measures a plugin of the installed environment
// that exposes `<plugin>.input` and `<plugin>.screen`. It judges no value and gates nothing.
//
//   node scripts/measure-terminal-text.mjs --sok PATH --config-dir DIR --plugin PLUGIN [--lines 1000,10000,100000] [--frames 600]
//     [--keys 40] [--json]
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "@soksak/client";
import { holdCovered, Session } from "@soksak/window-check/app.mjs";
import { measureApps, newWindow, openOnlyTab } from "./measure-app-usage.mjs";
import { delay, execute } from "./measure-tools.mjs";
import { applyTrace } from "./measure-trace.mjs";
import { presentedFramesOf, screenText } from "./measure-terminal-redraw.mjs";

/** The program that redraws rows at the bottom of the terminal (make measure-terminal-redraw), its rate, its rows and its lines. */
const REDRAW = fileURLToPath(new URL("./fixtures/status-redraw.mjs", import.meta.url));
const REDRAW_RATE = 30;
const REDRAW_ROWS = 20;
/** The seconds that the program draws after the interval, so that it draws during the whole interval. */
const REDRAW_MARGIN = 3;
const REDRAW_START = "status-redraw start";
const REDRAW_END = "status-redraw end";
/** The name of the text file in the project folder. */
const TEXT_FILE = "terminal-text.txt";
/** The length of the long line that every LONG_EVERY-th line is, in characters. */
export const LONG_LINE = 2000;
export const LONG_EVERY = 100;
/** Every WIDE_EVERY-th line holds wide characters, two cells each, and characters outside the basic multilingual plane. */
export const WIDE_EVERY = 10;

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      sok: { type: "string" },
      "config-dir": { type: "string" },
      plugin: { type: "string" },
      lines: { type: "string", default: "1000,10000,100000" },
      frames: { type: "string", default: "600" },
      keys: { type: "string", default: "40" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.sok || !values["config-dir"] || !values.plugin) throw new Error("required options: --sok PATH --config-dir DIR --plugin PLUGIN");
  if (!isAbsolute(values["config-dir"])) throw new Error(`--config-dir must be an absolute path (${values["config-dir"]})`);
  return {
    sok: values.sok, configDir: values["config-dir"], plugin: values.plugin, amounts: parseAmounts(values.lines),
    frames: positiveInteger("--frames", values.frames), keys: positiveInteger("--keys", values.keys), json: values.json,
  };
}

function positiveInteger(name, text) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer (${text})`);
  return value;
}

/** The amounts of lines of `text`, a comma-separated list of positive integers in increasing order. */
export function parseAmounts(text) {
  const amounts = text.split(",").map((part) => positiveInteger("--lines", part.trim()));
  for (let index = 1; index < amounts.length; index++) {
    if (amounts[index] <= amounts[index - 1]) throw new Error(`--lines must increase (${text})`);
  }
  return amounts;
}

/**
 * The text of the lines numbered from `from` (inclusive) to `to` (exclusive), each ending in a newline: a line of ASCII text with its
 * number, every WIDE_EVERY-th line with wide characters and characters outside the basic multilingual plane, and every LONG_EVERY-th
 * line a single line of LONG_LINE characters that the terminal wraps over several rows.
 */
export function textLines(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new Error(`textLines needs 0 <= from <= to, not ${from}, ${to}`);
  const lines = [];
  for (let number = from; number < to; number++) {
    const label = `line ${String(number).padStart(7, "0")}`;
    if (number % LONG_EVERY === LONG_EVERY - 1) lines.push(`${label} ${"0123456789".repeat(LONG_LINE / 10)}`.slice(0, LONG_LINE));
    else if (number % WIDE_EVERY === WIDE_EVERY - 1) lines.push(`${label} 한글 텍스트 漢字 かな 𝐀𝐁𝐂 🙂 wide cells`);
    else lines.push(`${label} the quick brown fox jumps over the lazy dog ${number % 7 === 0 ? "\u001b[1;32mcolor\u001b[0m" : "plain"}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The shell line that prints the file and then the end line of the amount `amount`, which the echo of the line does not contain. */
export function catLine(file, amount) {
  return `cat ${JSON.stringify(file)}; printf 'text-''end %d\\n' ${amount}\n`;
}

/** The end line that the shell prints after the file of the amount `amount`. */
export const endLine = (amount) => `text-end ${amount}`;

/** The load average and the CPU usage lines of the output of `top -l 1 -n 0`. */
export function loadLines(text) {
  return text.split("\n").filter((line) => /^(Load Avg|CPU usage):/.test(line)).map((line) => line.trim());
}

export async function readLoad() {
  const result = await execute("top", ["-l", "1", "-n", "0"]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`top exited with ${result.status}: ${String(result.stderr).trim()}`);
  return loadLines(result.stdout);
}

/** The figures of one interval of `measurement` (measureApps) over `actions` actions: each row with its CPU ms per action and its footprint. */
export function intervalFigures({ measurement, actions }) {
  if (!Number.isInteger(actions) || actions < 1) throw new Error(`an interval needs at least one action, not ${actions}`);
  const [app] = measurement.apps;
  const perAction = (seconds) => (seconds === null ? null : (seconds * 1000) / actions);
  return {
    seconds: measurement.seconds,
    actions,
    rows: app.rows.map((row) => ({ role: row.role, pid: row.pid, cpuSeconds: row.cpuSeconds, msPerAction: perAction(row.cpuSeconds), bytes: row.bytes })),
    totals: Object.fromEntries(Object.entries(app.totals).map(([name, sum]) => [name, { msPerAction: perAction(sum.cpuSeconds), bytes: sum.bytes }])),
    errors: measurement.errors,
  };
}

/** Reads presentedFrames of the region of `tab` in the window of `s` and the host.window value. */
export async function presented(s, tab) {
  const status = await s.get("host.window");
  return { frames: presentedFramesOf(status, tab, s.window), status };
}

/** Gives the image region of `tab` the native keyboard of the virtual key window, as a person who presses it does. */
export async function focusRegion(s, tab) {
  const region = (await s.get("host.window")).regions.find((item) => item.surface === tab);
  if (!region?.frame) throw new Error(`the image region of ${tab} has no frame`);
  const x = region.frame.x + region.frame.width / 2;
  const y = region.frame.y + region.frame.height / 2;
  await s.pointer(x, y, "move");
  await s.until("host.window", (window) => window.virtualKey, "the window did not become the virtual key window");
  await s.click(x, y);
  await s.until("host.window", (window) => window.responder?.surface === tab, `the tab ${tab} did not take the keyboard`);
}

/**
 * Waits until the region of `tab` presented a frame after `before` presented frames. It reads host.window once per display period and
 * does not watch it, because the host sends a watcher of host.window a new value for each presented frame, which the measurement would
 * count as a cost of the key.
 */
export async function untilPresented(s, tab, before, periodMs) {
  for (let read = 0; read < 1000; read++) {
    const { frames } = await presented(s, tab);
    if (frames > before) return frames;
    await delay(periodMs);
  }
  throw new Error(`the region of ${tab} presented no frame after ${before} frames in 1000 display periods`);
}

/** The content size of the window of the measurement in points, the window of make measure-app-usage. */
const WINDOW_SIZE = Object.freeze({ width: 1200, height: 760 });

/**
 * Opens a new window of the application of `s`, holds its covered drawing (holdCovered), opens a project of the folder `root` in it,
 * sets its content to WINDOW_SIZE and opens one tab of `plugin`, the only tab of its cards, which must register `<plugin>.input` and
 * `<plugin>.screen`. The window stays where the application shows it, behind the windows of a person, because a covered window draws
 * under the covered drawing as an uncovered one does. Returns the session of the window, the tab and the id of the project.
 */
async function prepareText(s, plugin, root) {
  const w = await newWindow(s);
  await holdCovered(w);
  const project = await w.run("core.project.open", { root });
  if (typeof project?.id !== "string") throw new Error(`core.project.open of ${root} answered no project id (${JSON.stringify(project)})`);
  await w.run("host.window.resize", WINDOW_SIZE);
  await w.until("host.window", (status) => status.content?.width === WINDOW_SIZE.width && status.content?.height === WINDOW_SIZE.height,
    `window ${w.window} did not reach a content of ${WINDOW_SIZE.width} by ${WINDOW_SIZE.height} points`);
  const { tab } = await openOnlyTab(w, plugin);
  await w.registered(tab, [`command ${plugin}.input`, `status ${plugin}.screen`]);
  return { s: w, tab, project: project.id };
}

/**
 * Measures one interval with measureApps: after the footprints, it reads the load of the machine and the presented frames and the
 * occlusion of the window, runs `span` or waits `seconds`, and reads them again. Returns the measurement with `load`, `presented` and
 * `occluded`, the occlusion of the window at the start and at the end.
 */
export async function interval({ s, tab, sok, configDir, footprints, seconds, span }) {
  let load;
  const measurement = await measureApps({
    sok, configDirs: [configDir], interval: seconds ?? 1, footprints, span,
    marks: {
      before: async () => {
        load = await readLoad();
        return presented(s, tab);
      },
      after: () => presented(s, tab),
    },
  });
  const { before, after } = measurement.marks;
  return { measurement, load, presented: after.frames - before.frames, occluded: [before.status.occluded, after.status.occluded] };
}

/** Clears the line of the shell with Control-U. */
export async function clearLine(s) {
  await s.key("u", "down", { modifiers: ["control"] });
  await s.key("u", "up", { modifiers: ["control"] });
}

async function measureAmount({ s, sok, configDir, plugin, tab, root, amount, written, frames, keys }) {
  appendFileSync(join(root, TEXT_FILE), textLines(written, amount));
  await s.run(`${plugin}.input`, { bytes: catLine(TEXT_FILE, amount) }, tab);
  await s.until(`${plugin}.screen`, (value) => screenText(value).includes(endLine(amount)), `the tab ${tab} did not show ${endLine(amount)}`,
    { surface: tab });
  const result = { amount };

  const { refreshRate } = await s.get("host.window");
  if (!(refreshRate > 0)) throw new Error(`host.window of ${s.window} reports the refresh rate ${JSON.stringify(refreshRate)}`);
  const idle = await interval({ s, tab, sok, configDir, footprints: "settled", seconds: frames / refreshRate });
  result.idle = { ...intervalFigures({ measurement: idle.measurement, actions: frames }), refreshRate, load: idle.load, presented: idle.presented, occluded: idle.occluded };

  const periodMs = 1000 / refreshRate;
  const typed = await interval({
    s, tab, sok, configDir, footprints: "at-once",
    span: async () => {
      let shown = (await presented(s, tab)).frames;
      for (let key = 0; key < keys; key++) {
        await s.key("a", "down", { text: "a" });
        await s.key("a", "up", { text: "a" });
        shown = await untilPresented(s, tab, shown, periodMs);
      }
    },
  });
  result.keys = { ...intervalFigures({ measurement: typed.measurement, actions: keys }), load: typed.load, presented: typed.presented, occluded: typed.occluded };
  await s.until(`${plugin}.screen`, (value) => screenText(value).replaceAll("\n", "").includes("a".repeat(keys)), `the tab ${tab} did not show the ${keys} typed keys`, { surface: tab });
  await clearLine(s);

  // The program redraws ROWS rows at the bottom of the screen RATE times per second over the interval, as an interactive program
  // draws its status; the interval divides the CPU time by the frames that the region presented.
  const seconds = frames / refreshRate;
  await s.run(`${plugin}.input`, { bytes: `node ${JSON.stringify(REDRAW)} ${REDRAW_RATE} ${seconds + REDRAW_MARGIN} ${REDRAW_ROWS}\n` }, tab);
  await s.until(`${plugin}.screen`, (value) => screenText(value).includes(REDRAW_START), `the tab ${tab} did not start the redraw`, { surface: tab });
  const redraw = await interval({ s, tab, sok, configDir, footprints: "at-once", seconds });
  if (redraw.presented < 1) throw new Error(`the region of ${tab} presented no frame while the program redrew its rows`);
  result.redraw = { ...intervalFigures({ measurement: redraw.measurement, actions: redraw.presented }), load: redraw.load, presented: redraw.presented, occluded: redraw.occluded };
  await s.until(`${plugin}.screen`, (value) => screenText(value).includes(REDRAW_END), `the redraw of ${tab} did not end`, { surface: tab });
  return result;
}

/**
 * Connects to the application of `configDir`, sets the trace state 0, opens the window and the tab of `plugin` on a new project folder
 * (prepareText), gives the tab the keyboard (focusRegion) and runs `body` with `{s, tab}`, the session of the window and the tab.
 * Afterwards it closes the project and the window and removes the folder, also when `body` failed; a failed cleanup is reported with
 * the failure of `body`. Returns the value of `body`.
 */
export async function withTerminalTab({ configDir, plugin, prefix }, body) {
  const client = await connect({ configDir });
  const root = mkdtempSync(join(tmpdir(), prefix));
  const s = new Session({ name: basename(configDir), configDir }, client);
  let prepared = null;
  let value;
  let failure = null;
  try {
    const windows = await client.request("windows.list");
    if (!Array.isArray(windows) || windows.length === 0) throw new Error(`${configDir} lists no window`);
    s.window = windows[0].window;
    await applyTrace((name, params) => s.run(name, params), 0, configDir, { ended: s.client.ended });
    prepared = await prepareText(s, plugin, root);
    await focusRegion(prepared.s, prepared.tab);
    value = await body({ s: prepared.s, tab: prepared.tab, root });
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
  return value;
}

async function measureText({ sok, configDir, plugin, amounts, frames, keys }) {
  const results = await withTerminalTab({ configDir, plugin, prefix: "terminal-text-project-" }, async ({ s, tab, root }) => {
    writeFileSync(join(root, TEXT_FILE), "");
    const measured = [];
    let written = 0;
    for (const amount of amounts) {
      measured.push(await measureAmount({ s, sok, configDir, plugin, tab, root, amount, written, frames, keys }));
      written = amount;
    }
    return measured;
  });
  return { plugin, frames, keys, results };
}

const mb = (bytes) => (bytes === null || bytes === undefined ? "error" : (bytes / 1048576).toFixed(1));
const ms = (value) => (value === null ? "error" : value.toFixed(3));

export function formatReport({ plugin, frames, keys, results }) {
  const lines = [];
  for (const { amount, idle, keys: typed, redraw } of results) {
    lines.push(`${plugin}: ${amount} lines`);
    lines.push(`  idle ${frames} display periods at ${idle.refreshRate} Hz, ${idle.seconds.toFixed(2)} s, ${idle.presented} presented frames, occluded ${idle.occluded.join("/")}; ${idle.load.join("; ")}`);
    lines.push(`  keys ${keys} keys in ${typed.seconds.toFixed(2)} s, ${typed.presented} presented frames, occluded ${typed.occluded.join("/")}; ${typed.load.join("; ")}`);
    lines.push(`  redraw ${redraw.presented} presented frames in ${redraw.seconds.toFixed(2)} s, occluded ${redraw.occluded.join("/")}; ${redraw.load.join("; ")}`);
    lines.push("  role pid idle-ms/period key-ms/key redraw-ms/frame footprint-MB");
    const of = (interval, pid) => interval.rows.find((item) => item.pid === pid);
    for (const row of idle.rows) {
      const key = of(typed, row.pid);
      const frame = of(redraw, row.pid);
      lines.push(`  ${row.role} ${row.pid} ${ms(row.msPerAction)} ${key === undefined ? "absent" : ms(key.msPerAction)} ` +
        `${frame === undefined ? "absent" : ms(frame.msPerAction)} ${mb(row.bytes)}`);
    }
    for (const name of Object.keys(idle.totals)) {
      lines.push(`  ${name} ${ms(idle.totals[name].msPerAction)} ${ms(typed.totals[name]?.msPerAction ?? null)} ` +
        `${ms(redraw.totals[name]?.msPerAction ?? null)} ${mb(idle.totals[name].bytes)}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await measureText(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    const errors = result.results.flatMap(({ idle, keys, redraw }) => [...idle.errors, ...keys.errors, ...redraw.errors]);
    for (const error of errors) console.error(`error: ${error}`);
    if (errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
