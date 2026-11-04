// Reports the CPU time that a shown terminal costs for each frame that its image region presents while its program rewrites ROWS rows at a
// fixed rate (docs/operations/examples.md, G5 of docs/spec/hosts.md). It sets the trace state TRACE (scripts/measure-trace.mjs), opens a
// new project window of 760 by 614 points with one tab of the terminal plugin PLUGIN through declared commands, starts
// scripts/fixtures/status-redraw.mjs in that tab with `<plugin>.input`, waits until `<plugin>.screen` shows the start line of the fixture,
// and ends that watch, because a watch of the screen relays every screen too. It then measures the CPU time of each process of the
// application over INTERVAL seconds with measure-app-usage.mjs and divides it by the change of presentedFrames of the image region of the
// tab in host.window over the same interval. The measurement fails while host.window of the window reports occluded true, because a
// covered window presents less often. It prints the CPU time of each process, its CPU milliseconds per presented frame and the presented
// frames per second, and closes the project window afterwards. Every error is printed to stderr, and the exit status is 1 when an error
// occurred. `make terminal-redraw-usage` runs it.
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
import { b3Conditions, writeB3Out } from "./b3-out.mjs";
import { b3OutOption, measureApps, newWindow, openOnlyTab, requireOcclusion } from "./measure-app-usage.mjs";
import { applyTrace, parseTrace, traceSettings } from "./measure-trace.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/status-redraw.mjs", import.meta.url));
const START = "status-redraw start";
/** The content size of the window of the measurement in points, the window of sidecar alacritty S21 (G5). */
const WINDOW_SIZE = Object.freeze({ width: 760, height: 614 });
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

/** The keys of the measurements of a B3 record of make terminal-redraw-usage. */
export const B3_MEASUREMENTS = Object.freeze(["hostCpuPerFrameMs", "applicationCpuPerFrameMs", "sidecarCpuPerFrameMs", "framesPerSecond", "presentedFrames"]);

/** The measurements of a B3 record of make terminal-redraw-usage (the keys that the header declares) from the frame cost of the region. */
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
 * Opens a new window of the application of the session s, opens a project of the folder root in it, sets its content to 760 by 614
 * points and opens one tab of plugin in it, the only tab of its cards; waits until the tab registers `<plugin>.input` and
 * `<plugin>.screen`. Returns the session of the window, the tab and the id of the project.
 */
export async function prepareRedraw(s, plugin, root) {
  const w = await newWindow(s);
  const project = await w.run("core.project.open", { root });
  if (typeof project?.id !== "string") throw new Error(`core.project.open of ${root} answered no project id (${JSON.stringify(project)})`);
  await w.run("host.window.resize", WINDOW_SIZE);
  await w.until("host.window", (status) => status.content?.width === WINDOW_SIZE.width && status.content?.height === WINDOW_SIZE.height,
    `window ${w.window} did not reach a content of ${WINDOW_SIZE.width} by ${WINDOW_SIZE.height} points`);
  const { tab } = await openOnlyTab(w, plugin);
  const entries = [`command ${plugin}.input`, `status ${plugin}.screen`];
  await w.until("core.surfaces", (list) => list.some((surface) => surface.surface === tab && entries.every((entry) => surface.exposes?.includes(entry))),
    `the ${plugin} tab ${tab} did not register ${entries.join(" and ")}`);
  return { s: w, tab, project: project.id };
}

/**
 * Measures the region of the surface tab in the window of the session s: measure(marks) runs the CPU interval of measureApps with the
 * marks, which read presentedFrames of the region right before the first and right after the last CPU reading and require the window
 * visible at both. covered(ms) resolves with the host.window value that reports occluded true within ms, or with null. Returns the
 * measurement, its frame cost and the host.window value of the window before the first CPU reading.
 */
export async function measureRegion({ s, tab, interval, measure, covered }) {
  let watch;
  const read = async () => {
    const status = await s.get("host.window");
    requireOcclusion(null, [{ window: s.window, occluded: status.occluded }]);
    return { presented: presentedFramesOf(status, tab, s.window), status };
  };
  const measurement = await measure({
    before: async () => {
      const frames = await read();
      watch = covered(interval * 1000);
      return frames;
    },
    after: async () => {
      const status = await watch;
      if (status !== null) throw new Error(`window ${s.window} reported occluded true during the interval: ${JSON.stringify(status.frame)}`);
      return read();
    },
  });
  const [app] = measurement.apps;
  const { before, after } = measurement.marks;
  const cost = frameCost({ rows: app.rows, totals: app.totals, presented: after.presented - before.presented, seconds: measurement.seconds });
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
    await applyTrace((name, params) => s.run(name, params), trace, configDir);
    prepared = await prepareRedraw(s, plugin, root);
    const { s: w, tab } = prepared;
    const text = `node ${JSON.stringify(FIXTURE)} ${rate} ${interval + DRAW_MARGIN} ${rows}\n`;
    await w.run(`${plugin}.input`, { bytes: text }, tab);
    // The watch ends when the start line is shown, because a watch of the screen relays every screen of the fixture too.
    const screen = await w.until(`${plugin}.screen`, (value) => screenText(value).includes(START), "the fixture did not start", { surface: tab });
    requireRows(screen, rows, tab);
    const { measurement, cost, status } = await measureRegion({
      s: w, tab, interval,
      measure: (marks) => measureApps({ sok, configDirs: [configDir], interval, footprints: "at-once", marks }),
      covered: (ms) => client.watch(w.window, "host.window", (status) => status.occluded === true, { timeout: ms })
        .catch((error) => {
          if (error.code === "ETIMEDOUT") return null;
          throw error;
        }),
    });
    // The conditions of a B3 output are read only for one: a plain measurement does not require a window on a screen.
    const conditions = b3Out === null ? null : redrawConditions({ status, window: w.window, trace, policy: readPolicy(configDir).classes });
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

function formatReport({ plugin, rows, rate, window, tab, seconds, cost }) {
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
