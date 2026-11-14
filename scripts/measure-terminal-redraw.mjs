// Reports the CPU time that a shown terminal costs for each frame that its image region presents while its program rewrites ROWS rows at a
// fixed rate (docs/operations/examples.md, G5 of docs/spec/hosts.md). It sets the trace state TRACE (scripts/measure-trace.mjs), opens a
// new project window of 760 by 614 points with one tab of the plugin PLUGIN through declared commands, starts
// scripts/fixtures/status-redraw.mjs in that tab with `<plugin>.input`, waits until `<plugin>.screen` shows the start line of the fixture,
// and ends that watch, because a watch of the screen relays every screen too. It then measures the CPU time of each process of the
// application over INTERVAL seconds with measure-app-usage.mjs and divides it by the change of presentedFrames of the image region of the
// tab in host.window over the same interval. The measurement fails while host.window of the window reports occluded true, because a
// covered window presents less often; it reads that status once per second, because a watch of host.window relays every presented frame
// and would add its own cost to each frame. It prints the CPU time of each process, its CPU milliseconds per presented frame and the presented
// frames per second, and closes the project window afterwards. It also prints the CPU time of the window server over the interval, which
// draws the whole screen and belongs to no application, so it stays outside the sums of the application and the B3 record. Every error is
// printed to stderr, and the exit status is 1 when an error occurred. `make measure-terminal-redraw` runs it.
//
// PLUGIN is an argument of the caller and has no default: the script names no plugin and measures a plugin of the installed environment
// that exposes `<plugin>.input` and `<plugin>.screen`. A tab that does not register them fails with the missing entries. It gates nothing.
//
// --b3-out FILE writes the B3 output of a measurement without an error to FILE through writeB3Out of scripts/b3-out.mjs, with the
// conditions of b3Conditions for the window of the measurement (redrawConditions). The keys, which B3_MEASUREMENTS lists, end in their
// unit:
//   hostCpuPerFrameMs, applicationCpuPerFrameMs,  CPU milliseconds per presented frame of the host, the application without its
//   sidecarCpuPerFrameMs                          sidecars, and the sidecars
//   framesPerSecond                               the presented frames per second
//   presentedFrames                               the change of presentedFrames of the region over the interval
//
//   node scripts/measure-terminal-redraw.mjs --sok PATH --config-dir DIR --plugin PLUGIN --rows ROWS --trace 0|1 [--rate 20] [--interval 10]
//     [--b3-out FILE] [--json]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "@soksak/client";
import { Session } from "@soksak/window-check/app.mjs";
import { readPolicy } from "@soksak/window-check/log-policy.mjs";
import { b3Conditions, b3End, writeB3Out } from "./b3-out.mjs";
import { b3OutOption, measureApps, newWindow, openOnlyTab, parseCpuTime, requireOcclusion } from "./measure-app-usage.mjs";
import { delay, execute, instant, remainingMs } from "./measure-tools.mjs";
import { applyTrace, parseTrace, traceSettings } from "./measure-trace.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/status-redraw.mjs", import.meta.url));
const START = "status-redraw start";
/** The content size of the window of the measurement in points, the window of sidecar alacritty S21 (G5). */
const WINDOW_SIZE = Object.freeze({ width: 760, height: 614 });
/** The milliseconds between two readings of host.window for a covered window during the interval. */
const COVERED_READ_MS = 1000;
/** The seconds that the fixture draws after the interval, so that it draws during the whole measurement. */
const DRAW_MARGIN = 5;

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      sok: { type: "string" },
      "config-dir": { type: "string" },
      plugin: { type: "string" },
      rows: { type: "string" },
      rate: { type: "string", default: "20" },
      interval: { type: "string", default: "10" },
      trace: { type: "string" },
      "b3-out": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.sok || !values["config-dir"] || !values.plugin || !values.rows) {
    throw new Error("required options: --sok PATH --config-dir DIR --plugin PLUGIN --rows ROWS --trace 0|1");
  }
  if (!isAbsolute(values["config-dir"])) throw new Error(`--config-dir must be an absolute path (${values["config-dir"]})`);
  const rows = Number(values.rows);
  if (!Number.isInteger(rows) || rows < 1) throw new Error(`--rows must be a positive integer (${values.rows})`);
  const rate = Number(values.rate);
  if (!Number.isInteger(rate) || rate < 1 || rate > 120) throw new Error(`--rate must be an integer from 1 to 120 (${values.rate})`);
  const interval = Number(values.interval);
  if (!(interval > 0)) throw new Error(`--interval must be a positive number of seconds (${values.interval})`);
  const trace = parseTrace(values.trace);
  return {
    sok: values.sok, configDir: values["config-dir"], plugin: values.plugin, rows, rate, interval, trace, b3Out: b3OutOption(values["b3-out"]), json: values.json,
  };
}

/** The text of a terminal screen value: each row joined from the characters of its cells, an empty cell as a space. */
export function screenText(rows) {
  if (!Array.isArray(rows)) throw new Error("terminal screen is not a list of rows");
  return rows.map((row) => row.map((cell) => cell.ch ?? " ".repeat(cell.width)).join("")).join("\n");
}

/** Requires a screen that holds the rows of the fixture and the row of its cursor below them, so that the fixture rewrites its rows without scrolling. */
export function requireRows(screen, rows, tab) {
  if (screen.length <= rows) throw new Error(`the terminal of ${tab} has ${screen.length} rows; the fixture rewrites ${rows} rows above the row of its cursor`);
}

/** The presentedFrames of the one image region of the surface tab in a host.window reply of window. */
export function presentedFramesOf(status, tab, window) {
  const regions = Array.isArray(status.regions) ? status.regions.filter((region) => region.surface === tab) : [];
  if (regions.length !== 1) throw new Error(`window ${window} has ${regions.length} image regions of ${tab}, not 1`);
  const [{ name, presentedFrames }] = regions;
  if (!Number.isInteger(presentedFrames) || presentedFrames < 0) {
    throw new Error(`the image region ${tab}/${name} of window ${window} reports presentedFrames ${JSON.stringify(presentedFrames)}, not a count`);
  }
  return presentedFrames;
}

/**
 * The CPU milliseconds of each process and of the sums of the application for each frame that the region presented over the interval
 * of seconds, and the presented frames per second. A row whose CPU time is null has an error in the errors list and no cost.
 */
export function frameCost({ rows, totals, presented, seconds }) {
  if (!Number.isInteger(presented) || presented <= 0) throw new Error(`the region presented no frame over the interval of ${seconds} s (${presented})`);
  const perFrame = (cpuSeconds) => (cpuSeconds === null ? null : (cpuSeconds * 1000) / presented);
  return {
    presented,
    framesPerSecond: presented / seconds,
    rows: rows.map((row) => ({ ...row, msPerFrame: perFrame(row.cpuSeconds) })),
    totals: Object.fromEntries(Object.entries(totals).map(([name, sum]) => [name, perFrame(sum.cpuSeconds)])),
  };
}

/**
 * Resolves with the host.window value of the window of the session s that reports occluded true within ms, or with null. It reads the
 * status once per second and at the end: the host sends a watcher of host.window a new value for each presented frame, which the
 * measurement would count as a cost of the frame.
 */
export async function untilCovered({ s, ms }) {
  const startedAt = instant();
  for (let wait = coveredWaitMs({ startedAt, now: startedAt, ms }); wait > 0; wait = coveredWaitMs({ startedAt, now: instant(), ms })) {
    await delay(wait);
    const status = await readCovered({ s });
    if (status !== null) return status;
  }
  return null;
}

/** The milliseconds of the next wait of untilCovered at the instant `now` of a watch of `ms` that began at the instant `startedAt`: a second, or the rest of the watch; 0 when the watch is over. */
export function coveredWaitMs({ startedAt, now, ms }) {
  return Math.min(COVERED_READ_MS, remainingMs({ since: startedAt, now, ms }));
}

/** The host.window value of the window of the session s when it reports occluded true, otherwise null. */
export async function readCovered({ s }) {
  const status = await s.get("host.window");
  return status.occluded === true ? status : null;
}

/** The pid and the CPU seconds of the window server in the rows of ps -axww -o pid=,time=,comm=. */
export function parseWindowServer(text) {
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*\/WindowServer)\s*$/.exec(line);
    if (match) return { pid: Number(match[1]), seconds: parseCpuTime(match[2]) };
  }
  throw new Error("the process table has no window server");
}

/** Reads the window server from the process table. */
async function readWindowServer() {
  const result = await execute("ps", ["-axww", "-o", "pid=,time=,comm="]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ps exited with ${result.status}: ${String(result.stderr).trim()}`);
  return parseWindowServer(result.stdout);
}

/** The keys of the measurements of a B3 record of make measure-terminal-redraw. */
export const B3_MEASUREMENTS = Object.freeze(["hostCpuPerFrameMs", "applicationCpuPerFrameMs", "sidecarCpuPerFrameMs", "framesPerSecond", "presentedFrames"]);

/** The measurements of a B3 record of make measure-terminal-redraw (the keys that the header declares) from the frame cost of the region. */
export function redrawMeasurements(cost) {
  const host = cost.rows.find(({ role }) => role === "host");
  if (host === undefined) throw new Error("the measurement has no host row");
  return {
    hostCpuPerFrameMs: host.msPerFrame,
    applicationCpuPerFrameMs: cost.totals.application,
    sidecarCpuPerFrameMs: cost.totals.sidecars,
    framesPerSecond: cost.framesPerSecond,
    presentedFrames: cost.presented,
  };
}

/**
 * The conditions of the B3 output of the redraw: b3Conditions of scripts/b3-out.mjs with the host.window value of the window of the
 * measurement before the first CPU reading, the diagnostics.performance of the trace state and the classes of the policy in force.
 */
export function redrawConditions({ status, window, trace, policy }) {
  return b3Conditions({ windows: [{ ...status, window }], performance: traceSettings(trace)["diagnostics.performance"], policy });
}

/**
 * The conditions of the B3 output from the host.window value `status` before the first CPU reading and a reading of the window of the session
 * s now (b3End). The measurement reads them after the interval, as the last reading of a window that it closes before it writes the output.
 */
export async function readRedrawConditions({ s, status, trace, policy }) {
  return redrawConditions({ status: { ...status, ...b3End(status, await s.get("host.window")) }, window: s.window, trace, policy });
}

/**
 * Opens a new window of the application of the session s, opens a project of the folder root in it, sets its content to 760 by 614
 * points and opens one tab of plugin in it, the only tab of its cards; waits until the tab registers `<plugin>.input` and
 * `<plugin>.screen`, and fails with the entries that the tab did not register. Returns the session of the window, the tab and the id of
 * the project.
 */
export async function prepareRedraw(s, plugin, root) {
  const w = await newWindow(s);
  const project = await w.run("core.project.open", { root });
  if (typeof project?.id !== "string") throw new Error(`core.project.open of ${root} answered no project id (${JSON.stringify(project)})`);
  await w.run("host.window.resize", WINDOW_SIZE);
  await w.until("host.window", (status) => status.content?.width === WINDOW_SIZE.width && status.content?.height === WINDOW_SIZE.height,
    `window ${w.window} did not reach a content of ${WINDOW_SIZE.width} by ${WINDOW_SIZE.height} points`);
  // A covered region sends no screen, so the start line of the fixture would never come.
  await w.until("host.window", (status) => status.occluded === false, `window ${w.window} is covered by another window`);
  const { tab } = await openOnlyTab(w, plugin);
  const entries = [`command ${plugin}.input`, `status ${plugin}.screen`];
  try {
    await w.until("core.surfaces", (list) => list.some((surface) => surface.surface === tab && entries.every((entry) => surface.exposes?.includes(entry))),
      `the ${plugin} tab ${tab} did not register ${entries.join(" and ")}`);
  } catch (error) {
    // default: a tab that core.surfaces does not list exposes nothing.
    const exposes = (await w.get("core.surfaces")).find((surface) => surface.surface === tab)?.exposes ?? [];
    const missing = entries.filter((entry) => !exposes.includes(entry));
    if (missing.length === 0) throw error;
    throw new Error(`the ${plugin} tab ${tab} did not register ${missing.join(" and ")}`, { cause: error });
  }
  return { s: w, tab, project: project.id };
}

/**
 * Reads presentedFrames of the region of the surface tab in the window of the session s, which must not be occluded. Returns the
 * presented frames and the host.window value.
 */
export async function readRegion(s, tab) {
  const status = await s.get("host.window");
  requireOcclusion(null, [{ window: s.window, occluded: status.occluded }]);
  return { presented: presentedFramesOf(status, tab, s.window), status };
}

/** Requires that the window reported no occluded true during the interval: `covered` is the value of untilCovered. */
export function requireUncovered(window, covered) {
  if (covered !== null) throw new Error(`window ${window} reported occluded true during the interval: ${JSON.stringify(covered.frame)}`);
}

/**
 * The cost of the frames of the region from the measurement of measureApps with its marks `before` and `after` (the results of
 * readRegion), the readings `first` and `last` of the window server (parseWindowServer) at the same marks, and the host.window value
 * of the window before the first CPU reading. The frame cost holds the CPU time of the window server over the interval.
 */
export function regionCost({ measurement, first, last }) {
  const [app] = measurement.apps;
  const { before, after } = measurement.marks;
  const cost = frameCost({ rows: app.rows, totals: app.totals, presented: after.presented - before.presented, seconds: measurement.seconds });
  const server = { pid: first.pid, cpuSeconds: last.seconds - first.seconds };
  cost.windowServer = { ...server, msPerFrame: (server.cpuSeconds * 1000) / cost.presented };
  return { measurement, cost, status: before.status };
}

/** Closes the project window of the measurement and waits until host.windows no longer lists it. */
async function closeRedraw(s, prepared) {
  const { closed } = await prepared.s.run("core.project.close", { id: prepared.project });
  if (closed !== true) throw new Error(`core.project.close kept the project ${prepared.project} of the measurement (closed ${closed})`);
  await prepared.s.close();
  await s.until("host.windows", (list) => !list.some((entry) => entry.window === prepared.s.window), `window ${prepared.s.window} did not close`);
}

async function measureRedraw({ sok, configDir, plugin, rows, rate, interval, trace, b3Out }) {
  const client = await connect({ configDir });
  const root = mkdtempSync(join(tmpdir(), "terminal-redraw-project-"));
  const s = new Session({ name: basename(configDir), configDir }, client);
  let prepared = null;
  let result;
  let failure = null;
  try {
    const windows = await client.request("windows.list");
    if (!Array.isArray(windows) || windows.length === 0) throw new Error(`${configDir} lists no window`);
    s.window = windows[0].window;
    await applyTrace((name, params) => s.run(name, params), trace, configDir, { ended: s.client.ended });
    prepared = await prepareRedraw(s, plugin, root);
    const { s: w, tab } = prepared;
    const text = `node ${JSON.stringify(FIXTURE)} ${rate} ${interval + DRAW_MARGIN} ${rows}\n`;
    await w.run(`${plugin}.input`, { bytes: text }, tab);
    // The watch ends when the start line is shown, because a watch of the screen relays every screen of the fixture too.
    const screen = await w.until(`${plugin}.screen`, (value) => screenText(value).includes(START), "the fixture did not start", { surface: tab });
    requireRows(screen, rows, tab);
    let watch;
    let first;
    let last;
    const measurement = await measureApps({
      sok, configDirs: [configDir], interval, footprints: "at-once",
      marks: {
        before: async () => {
          const reading = await readRegion(w, tab);
          first = await readWindowServer();
          watch = untilCovered({ s: w, ms: interval * 1000 });
          return reading;
        },
        after: async () => {
          requireUncovered(w.window, await watch);
          const reading = await readRegion(w, tab);
          last = await readWindowServer();
          return reading;
        },
      },
    });
    const { cost, status } = regionCost({ measurement, first, last });
    // The conditions of a B3 output are read only for one: a plain measurement does not require a window on a screen.
    const conditions = b3Out === null ? null : await readRedrawConditions({ s: w, status, trace, policy: readPolicy(configDir).classes });
    result = { plugin, rows, rate, interval, window: w.window, tab, seconds: measurement.seconds, cost, conditions, errors: measurement.errors };
  } catch (error) {
    failure = error;
  }
  // The measurement leaves no window, project or folder behind; a failed cleanup is reported with the failure of the measurement.
  const cleanup = [];
  if (prepared !== null) {
    try {
      await closeRedraw(s, prepared);
    } catch (error) {
      cleanup.push(error);
    }
  }
  client.close();
  rmSync(root, { recursive: true, force: true });
  const errors = [failure, ...cleanup].filter((error) => error !== null);
  if (errors.length > 1) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  if (errors.length === 1) throw errors[0];
  return result;
}

export function formatReport({ plugin, rows, rate, window, tab, seconds, cost }) {
  const value = (number, digits) => (number === null ? "error" : number.toFixed(digits));
  const lines = [
    `${plugin} tab ${tab} of window ${window}: ${rows} rows at ${rate} frames per second, ${seconds.toFixed(2)} s, ` +
      `${cost.presented} presented frames (${cost.framesPerSecond.toFixed(1)} per second)`,
    "role pid cpu-s ms/frame attribution",
  ];
  for (const row of cost.rows) lines.push([row.role, row.pid, value(row.cpuSeconds, 3), value(row.msPerFrame, 2), row.attribution ?? ""].join(" "));
  lines.push(`application without sidecars ${value(cost.totals.application, 2)} ms/frame`);
  lines.push(`sidecars ${value(cost.totals.sidecars, 2)} ms/frame`);
  lines.push(`total ${value(cost.totals.total, 2)} ms/frame`);
  lines.push(`window server ${cost.windowServer.pid} ${value(cost.windowServer.cpuSeconds, 3)} ${value(cost.windowServer.msPerFrame, 2)} the whole screen`);
  lines.push(`total with the window server ${value(cost.totals.total + cost.windowServer.msPerFrame, 2)} ms/frame`);
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await measureRedraw(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    for (const error of result.errors) console.error(`error: ${error}`);
    if (result.errors.length > 0) process.exitCode = 1;
    // A measurement with an error records no B3 values: its figures miss a process.
    else if (options.b3Out !== null) writeB3Out(options.b3Out, { measurements: redrawMeasurements(result.cost), conditions: result.conditions });
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
