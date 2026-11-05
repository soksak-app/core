// Reports the CPU and memory of the running applications of the given data folders, by process (docs/operations/examples.md), and
// prepares the states of the three-host benchmark B3 that it measures (docs/operations/examples.md).
// The host is the process whose command line has --config-dir DIR. The sidecars are the processes whose executable is under DIR/sidecars/.
// The page and document processes come from sok windows and from sok status host.window of each window; a window whose host.window
// reports pageProcess null has no main page and no page row. The WebKit GPU, networking and WebContent services belong to the application
// whose host lists them in its launchd domain (launchctl print pid/<host>). A WebKit GPU or networking process (pgrep -f
// com.apple.WebKit.GPU|Networking) that no application claims is printed as unattributed, and one that ends during the measurement leaves that list without an error. The memory of a process is its phys_footprint
// and its phys_footprint_peak (footprint -p PID -f bytes); each footprint is read after the readings of every process settle by the rule of
// G3 that scripts/footprints.mjs reads: two consecutive readings 5 seconds apart differ by less than 1,024 KB, and the reading is at least
// 3 seconds after the last frame. The U7 records of the pointer step are read through scripts/frame-records.mjs. The CPU time of a
// process is the CPU time that ps reports, read at two points INTERVAL seconds apart. The sidecars are summed apart from the application.
//
// --trace 0|1 sets the trace state with core.settings.change before the measurement (scripts/measure-trace.mjs); --trace frame-records,
// which needs --step pointer, sets the trace state of the frame records (FRAME_RECORDS) for both moves of the pointer step. --state
// prepares a state of B3 through declared commands in a window of 1200 by 760 points: S0 (the library screen without a plugin view), S0b (the window after its
// project closed, each WebContent process of a view page or a document region read before the close exited), S1 (one term tab and one
// browser tab on a blank page of a loopback server that ends with the measurement), S9 (S1 under a second library window that covers it),
// S11 (S1 with a second project window beside it), S12 (S1 after one layout draw that fails), S14 (S0 10 seconds after one character in the
// library search) and S15 (S1 with the settings window open). --idle waits for the cursor idle timeout of every tab whose plugin exposes a
// cursor status (the term and terminal tabs) and then for 3 seconds without a change of frames of host.window, or 3 seconds on a window
// whose frames is null. --step pointer moves the pointer across the window, already the key window and not occluded, with the moves of
// input.pointer, which take no permission and leave the cursor, reads the CPU time over the move and the footprints before and after it, and
// repeats the move in the trace state of the frame records (FRAME_RECORDS) to read the U7 records of a window without a main page. The
// measurement prints occluded, the trace switch, the log policy, the runtime figures of diagnostics.objects and frames and commandBuffers
// of each window before the first and after the last CPU reading, and requires occluded false in every window, except the covered window of
// S9, which must report occluded true. It prints each counter of host.window that every window reports null and an idle wait that read
// no frame as not measured. Every error is printed to stderr with the process or window it concerns, and the exit status is 1
// when an error occurred. `make measure-app-usage` runs it.
//
// --b3-out FILE writes the B3 output of a measurement of one application without an error to FILE through writeB3Out of
// scripts/b3-out.mjs: {"measurements": {KEY: number}, "conditions": {refreshRate, backingScale, traceState, logPolicy, window}}. The
// conditions are those of b3Conditions: the refresh rate and the backing scale that every window reports in host.window, traceState, the
// diagnostics.performance of the trace state of the CPU interval (true or false), the classes of the log policy in force, and the content
// size of the window of the state, read before the first CPU reading. One output holds the keys of one trace state, the state of its
// measured interval: under --step pointer, --trace 0|1 writes the keys of the first move except pointerMoveP90Ms, and --trace frame-records
// writes pointerMoveP90Ms alone, from the repeated move in that state. The keys, which B3_MEASUREMENTS lists for each trace state, end in
// their unit:
//   hostCpuSeconds, applicationCpuSeconds,       CPU seconds over the interval of the host, the application without its sidecars,
//   sidecarCpuSeconds                            and the sidecars
//   hostFootprintKb, applicationFootprintKb,     footprints in KB (1,024 bytes) read before the interval
//   sidecarFootprintKb
//   applicationFootprintAfterKb                  the application footprint in KB after the pointer move (--step pointer
//                                                --trace 0|1)
//   applicationPeakFootprintKb                   the sum of the peak footprints in KB after the last CPU reading
//   webKitProcesses, webContentProcesses         the WebKit processes of the application, and its WebContent processes (page,
//                                                document and WebContent service rows)
//   frames, commandBuffers                       the change of frames and commandBuffers of host.window over the interval, summed
//                                                over the windows; absent on a host that reports them null
//   errorLines                                   the error lines of the layout fault (S12)
//   pointerMoveP90Ms                                 the 90th percentile in ms of the mouseMoved: step with a hitTest: step right before it
//                                                pointer --trace frame-records on a window without a main page)
//
//   node scripts/measure-app-usage.mjs --sok PATH --config-dir DIR [--config-dir DIR ...] --trace 0|1|frame-records [--interval SECONDS]
//     [--state S0|S0b|S1|S9|S11|S12|S14|S15] [--idle] [--step pointer] [--b3-out FILE] [--json]
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { basename, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "@soksak/client";
import { Session } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEventErrors, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { readPolicy } from "@soksak/window-check/log-policy.mjs";
import { launchdServices } from "@soksak/window-check/stall-sample.mjs";
import { catalogOf } from "./check-events.mjs";
import { b3Conditions, b3End, writeB3Out } from "./b3-out.mjs";
import { readFootprint, settledFootprints } from "./footprints.mjs";
import { percentile, requireCompleteGesture, stepTimes, U7_EVENTS } from "./frame-records.mjs";
import { applyTrace, FRAME_RECORDS, parseTrace, traceSettings } from "./measure-trace.mjs";

/** Executables of the tools that run this measurement; their command lines name the data folder, but they are not the application. */
const TOOL_EXECUTABLES = new Set(["node", "sh", "bash", "zsh", "make", "sok"]);

/** The states of B3 that --state prepares (docs/operations/examples.md, B3). */
export const STATES = ["S0", "S0b", "S1", "S9", "S11", "S12", "S14", "S15"];

/** The content size of the window of every state of B3, in points. */
export const WINDOW_SIZE = Object.freeze({ width: 1200, height: 760 });

/** The time without a change of frames after which a window is quiet, and the intervals after which frames that keep changing fail. */
const QUIET_MS = 3000;
const QUIET_INTERVALS = 40;
/** S14 reads its footprints this long after the key, while the caret blinks (G3). */
const KEY_READING_MS = 10000;
/** The covering window of S9 exceeds the window by this margin on each side, so that it also covers the shadow of the window. */
const COVER_MARGIN = 60;
/** S12 narrows the window by this width, so that the layout draws again and the draw fails. */
const FAULT_RESIZE = 40;
/** The text of the layout fault that diagnostics.layout.fail causes (docs/spec/endpoint.md). */
const LAYOUT_FAULT = "diagnostic layout fault";
/** The wait for the error line of the layout fault in the application log. */
const FAULT_LINE_LIMIT = 30000;
/** The HID moves of the pointer step across the window. */
const POINTER_MOVES = 60;
/** The plugins of the tabs of S1. */
const S1_TERMINAL = "term";
const S1_BROWSER = "browser";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parses a CPU time of ps, [[dd-]hh:]mm:ss.ss, into seconds. */
export function parseCpuTime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2}\.\d{2})$/.exec(text);
  if (!match) throw new Error(`cpu time "${text}" is not in the [[dd-]hh:]mm:ss.ss format`);
  const [, days, hours, minutes, seconds] = match;
  if (Number(seconds) >= 60) throw new Error(`cpu time "${text}" has seconds of 60 or more`);
  if (hours !== undefined && Number(minutes) >= 60) throw new Error(`cpu time "${text}" has minutes of 60 or more`);
  if (days !== undefined && Number(hours) >= 24) throw new Error(`cpu time "${text}" has hours of 24 or more`);
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** The CPU share of a process over an interval: the CPU seconds it used divided by the interval, in percent. */
export function cpuPercent(before, after, intervalSeconds) {
  if (!(intervalSeconds > 0)) throw new Error(`interval must be a positive number of seconds (${intervalSeconds})`);
  if (after < before) throw new Error(`cpu time decreased from ${before} to ${after}`);
  return ((after - before) / intervalSeconds) * 100;
}

/** The output limit of the process table, whose command lines reach several MB on a machine with many extensions. */
export const PROCESS_TABLE_BYTES = 64 * 1024 * 1024;

/** Parses the rows of ps -axo pid=,command= into { pid, command }. */
export function parseProcessTable(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) throw new Error(`process row "${line}" has no pid`);
      return { pid: Number(match[1]), command: match[2] };
    });
}

/** Parses the rows of ps -axo pid=,time= into a map from pid to CPU seconds. */
export function parseCpuSamples(text) {
  const samples = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error(`cpu sample row "${line}" has no pid and time`);
    samples.set(Number(match[1]), parseCpuTime(match[2]));
  }
  return samples;
}

/** The lexical form of a path: doubled and trailing slashes removed. A launch command line can carry a doubled slash that the path does not need. */
function lexicalPath(path) {
  const normalized = posix.normalize(path);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** The command line with its doubled slashes removed, so that it compares with lexicalPath. */
function lexicalCommand(command) {
  return command.replace(/\/{2,}/g, "/");
}

function hasConfigDirArgument(command, configDir) {
  const argument = `--config-dir ${lexicalPath(configDir)}`;
  const line = lexicalCommand(command);
  const index = line.indexOf(argument);
  return index !== -1 && (index + argument.length === line.length || line[index + argument.length] === " ");
}

/** The sidecar directory prefixes of a data folder. A process can carry the path as given or the real path of a symbolic link. */
function sidecarPrefixes(configDir, realPath) {
  return [...new Set([configDir, realPath].map((dir) => `${lexicalPath(dir)}/sidecars/`))];
}

function sidecarPrefixOf(command, configDir, realPath) {
  const line = lexicalCommand(command);
  return sidecarPrefixes(configDir, realPath).find((prefix) => line.startsWith(prefix));
}

function isTool(command) {
  return TOOL_EXECUTABLES.has(basename(command.split(" ")[0]));
}

/** The host process of a data folder: the one application process whose command line has --config-dir DIR. */
export function hostProcess(table, configDir, realPath = configDir) {
  const hosts = table.filter(
    ({ command }) =>
      !isTool(command) &&
      [configDir, realPath].some((dir) => hasConfigDirArgument(command, dir)) &&
      sidecarPrefixOf(command, configDir, realPath) === undefined &&
      !command.includes("com.apple.WebKit."),
  );
  if (hosts.length === 0) throw new Error(`no host process has --config-dir ${configDir}`);
  if (hosts.length > 1) throw new Error(`${hosts.length} host processes have --config-dir ${configDir}: ${hosts.map(({ pid }) => pid).join(", ")}`);
  return { pid: hosts[0].pid };
}

/**
 * The sidecar processes of a data folder: the processes whose executable is under DIR/sidecars/. realPath is the real path of the data folder,
 * which the sidecars are launched from when the data folder is named through a symbolic link.
 */
export function sidecarProcesses(table, configDir, realPath = configDir) {
  const rows = [];
  for (const { pid, command } of table) {
    const prefix = sidecarPrefixOf(command, configDir, realPath);
    if (prefix === undefined) continue;
    rows.push({ role: `sidecar ${lexicalCommand(command).slice(prefix.length).split(/[ /]/)[0]}`, pid, attribution: "executable path" });
  }
  return rows;
}

/** The role of each WebKit service by the prefix of its launchd label. */
const WEBKIT_ROLES = [
  ["com.apple.WebKit.GPU.", "webkit gpu"],
  ["com.apple.WebKit.Networking.", "webkit networking"],
  ["com.apple.WebKit.WebContent.", "webkit webcontent"],
];

/**
 * Attributes the WebKit services to the applications. Each host is { configDir, pid }. A WebKit service belongs to the
 * application whose host has it in its launchd domain. `launchctl print pid/<host>` is read because it is the only interface
 * that lists the services of another process; a start time or an open file does not separate two applications that started in
 * the same second or share a file. Returns the attributed rows in the order of the hosts and the errors of the hosts whose
 * domain cannot be read.
 *
 * run(command, args)  an executor that resolves to {status, stdout, stderr}. The tests replace it.
 */
export async function attributeWebKit(hosts, run) {
  const attributed = [];
  const errors = [];
  for (const { configDir, pid } of hosts) {
    let services;
    try {
      services = await launchdServices(pid, run);
    } catch (error) {
      errors.push(`webkit services of ${configDir}: ${error.message}`);
      continue;
    }
    for (const service of services) {
      const role = WEBKIT_ROLES.find(([prefix]) => service.label.startsWith(prefix))?.[1];
      if (role !== undefined) attributed.push({ configDir, role, pid: service.pid, attribution: "launchd domain" });
    }
  }
  return { attributed, errors };
}

/** The summed figures of the rows. */
const FIGURES = ["bytes", "peakBytes", "cpuSeconds", "cpuPercent"];

/**
 * Sums the rows of one application: the application without its sidecars, the sidecars, which run the same sidecar builds on every
 * host (G1, G3), and both. A row whose value is null has an error in the errors list, and the sum leaves that value out. A
 * measurement that reads the footprints after its span too also sums bytesAfter.
 */
export function totalsOf(rows) {
  const figures = rows.some((row) => "bytesAfter" in row) ? [...FIGURES, "bytesAfter"] : FIGURES;
  const sum = (selected) => Object.fromEntries(figures.map((figure) =>
    [figure, selected.reduce((total, row) => total + (row[figure] ?? 0), 0)]));
  const sidecar = (row) => row.role.startsWith("sidecar ");
  return { application: sum(rows.filter((row) => !sidecar(row))), sidecars: sum(rows.filter(sidecar)), total: sum(rows) };
}

/**
 * The page and document rows of one window and the errors of its host.window reply. A window whose host.window reports pageProcess
 * null has no main page, because the mygo host draws its workbench natively (docs/spec/hosts.md), so it has no page row.
 */
export function windowRows(window, configDir, status) {
  const where = `page of window ${window} of ${configDir}`;
  const rows = [];
  const errors = [];
  if (status.pageProcess !== null) {
    if (!Number.isInteger(status.pageProcess) || status.pageProcess <= 0) {
      errors.push(`${where}: no page process (${JSON.stringify(status.pageProcess)})`);
    } else {
      rows.push({ role: `page ${window}`, pid: status.pageProcess, attribution: "host.window" });
    }
  }
  if (!Array.isArray(status.documents)) {
    errors.push(`${where}: host.window reply has no documents array`);
    return { rows, errors };
  }
  for (const document of status.documents) {
    const role = `document ${document.surface}/${document.document}`;
    if (Number.isInteger(document.process) && document.process > 0) {
      rows.push({ role, pid: document.process, attribution: "host.window" });
    } else if (document.document !== "" && document.process === 0 && document.visible === false) {
      // A hidden document of a view holds no process until it loads, so it has nothing to read. A shown document and the view itself must have one.
      continue;
    } else {
      errors.push(`${role} of window ${window} of ${configDir}: no process (${JSON.stringify(document.process)})`);
    }
  }
  return { rows, errors };
}

/**
 * Requires occluded false of every window, because a covered window draws less often and its figures measure another state
 * (docs/spec/exposure.md), except the first window of S9, which the second window covers and which must report occluded true.
 * readings holds { window, occluded } in the order of the windows of the state.
 */
export function requireOcclusion(state, readings) {
  readings.forEach(({ window, occluded }, index) => {
    if (typeof occluded !== "boolean") throw new Error(`window ${window} reports occluded ${JSON.stringify(occluded)}, not a boolean`);
    const required = state === "S9" && index === 0;
    if (occluded !== required) throw new Error(`window ${window} reports occluded ${occluded}; ${state ?? "the measurement"} requires occluded ${required}`);
  });
}

/** Whether two lists of frames of the windows are equal; a window whose frames is null counts no frame. */
const sameFrames = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const framesText = (frames) => frames.map(String).join(" ");

/**
 * Waits until frames of host.window of every window has not changed for 3 seconds; a window whose frames is null waits the 3 seconds
 * (docs/spec/hosts.md, G2). frames() returns the frames of each window, and sleep(ms) waits, by default on the timer that
 * measureApps uses, so a caller writes no timer of its own. The host notifies host.window watchers
 * when settled changes, not at each frame, and frames counts every frame, so two readings 3 seconds apart are the rule itself.
 */
export async function untilFramesQuiet({ frames, sleep = delay, intervals = QUIET_INTERVALS }) {
  let previous = await frames();
  for (let interval = 1; interval <= intervals; interval++) {
    await sleep(QUIET_MS);
    const current = await frames();
    if (sameFrames(previous, current)) return current;
    if (interval === intervals) {
      throw new Error(`the frames of the windows changed in each of ${intervals} intervals of 3 s; frames ${framesText(previous)} then ${framesText(current)}`);
    }
    previous = current;
  }
  throw new Error(`untilFramesQuiet needs at least 1 interval, not ${intervals}`);
}

/**
 * The milliseconds of the wait of --idle between the last request and the first CPU reading. A request is an event that the gate of the
 * default policy counts, and a count waits for at most a minute before a writer that sleeps writes it (docs/spec/logging.md#policy). No status
 * announces the end of that wait, and asking would count again, so the wait is the time itself with the time the writer takes to wake.
 * Those writes belong to the preparation and are no cost of the settled state.
 */
export const COUNT_WAIT_MS = 62000;

/** The number of lines of each event log of the configuration folder, which it reads without a request to the application. */
export function logLineCounts(configDir) {
  const logs = join(configDir, "logs");
  const counts = new Map();
  for (const name of readdirSync(logs)) {
    if (name.endsWith(".jsonl")) counts.set(name, readFileSync(join(logs, name), "utf8").split("\n").length - 1);
  }
  return counts;
}

/** The lines that the event logs gained between two readings of logLineCounts. */
export function recordsOver(before, after) {
  let gained = 0;
  for (const [name, lines] of after) gained += lines - (before.get(name) ?? 0);
  return gained;
}

/** The tabs whose plugin exposes a cursor status `<plugin>.cursor` with its idle timeout: the term and terminal tabs. */
export function cursorTabs(surfaces) {
  return surfaces.filter((surface) => surface.kind === "tab" && surface.exposes?.includes(`status ${surface.plugin}.cursor`));
}

/**
 * Waits for the cursor idle timeout of every cursor tab of every window and then until frames has not changed for 3 seconds (G2). The
 * idle timeout is a time after the last input, the preparation, that no status announces, so a timer of the longest timeout waits it.
 * sessions holds a session of each window, frames() returns the frames of each window and sleep(ms) waits. It resolves "quiet" when every
 * window reports its frames, and "not measured" when a window reports null: that wait read nothing of the window.
 */
export async function waitIdle({ sessions, frames, sleep }) {
  let longest = 0;
  for (const s of sessions) {
    const surfaces = await s.get("core.surfaces");
    if (!Array.isArray(surfaces)) throw new Error(`core.surfaces of window ${s.window} is not a list (${JSON.stringify(surfaces)})`);
    for (const { surface, plugin } of cursorTabs(surfaces)) {
      const { idleTimeout } = await s.get(`${plugin}.cursor`, surface);
      if (!Number.isFinite(idleTimeout) || idleTimeout < 0) {
        throw new Error(`surface ${surface} of window ${s.window} reports ${plugin}.cursor idleTimeout ${JSON.stringify(idleTimeout)}, not a number of milliseconds`);
      }
      longest = Math.max(longest, idleTimeout);
    }
  }
  if (longest > 0) await sleep(longest);
  const quiet = await untilFramesQuiet({ frames, sleep });
  return quiet.every(Number.isInteger) ? "quiet" : "not measured";
}

/**
 * The lines of the report for what the measurement did not read: an idle wait (`idle`, the result of waitIdle, or null without one) that
 * read no frame, and each counter of host.window that is null in every window. Such a value is no pass of the rule that reads it.
 */
export function notMeasuredLines({ idle, marks }) {
  const lines = [];
  if (idle === "not measured") lines.push("idle: not measured: the wait read no frame of a window whose frames is null, so it only waited");
  for (const name of ["frames", "commandBuffers"]) {
    if (counterChange(name, marks) === undefined) lines.push(`not measured: ${name} of host.window is null in every window`);
  }
  return lines;
}

/** The number of error lines of the layout fault among the lines of the application log (`error <layer> <where>: <text>`). */
export function faultErrorCount(lines) {
  return lines.filter((line) => line.startsWith("error ") && line.includes(LAYOUT_FAULT)).length;
}

/**
 * The figures of the U7 records of one pointer move over a window without a main page: the frame records, the change of frames of
 * host.window, and the 90th percentile (G8), in milliseconds, of the moves that were delivered. The value of a move is its outermost
 * `mouseMoved:` step, with the `hitTest:` step right before it when there is one: a move reaches the view through the tracking area and
 * mostly without a hit test. The records must be complete (requireCompleteGesture). A nested step, such as the isFlipped that a hitTest:
 * sends, runs inside the step that sends it and is part of its time, so only a step that no other step contains counts.
 */
export function gestureFigures({ records, dropped, window, framesBefore, framesAfter, fromSeq, toSeq }) {
  const own = requireCompleteGesture({ records, dropped, window, framesBefore, framesAfter, fromSeq, toSeq });
  const steps = stepTimes(own);
  const contains = (outer, inner) => outer !== inner && outer.entryNs <= inner.entryNs && inner.returnNs <= outer.returnNs &&
    (outer.entryNs !== inner.entryNs || outer.returnNs !== inner.returnNs);
  const outermost = steps.filter((step) => !steps.some((other) => contains(other, step))).toSorted((a, b) => (a.entryNs < b.entryNs ? -1 : a.entryNs > b.entryNs ? 1 : 0));
  const moves = [];
  outermost.forEach((step, index) => {
    if (step.callback !== "mouseMoved:") return;
    const before = outermost[index - 1];
    moves.push(before?.callback === "hitTest:" ? step.ms + before.ms : step.ms);
  });
  if (moves.length === 0) throw new Error(`the gesture of window ${window} has no mouseMoved: step`);
  return {
    frameRecords: own.filter((record) => record.event === U7_EVENTS.frame).length,
    framesChange: framesAfter - framesBefore,
    moves: moves.length,
    p90Ms: percentile(moves.toSorted((a, b) => a - b), 0.9),
  };
}

/** The moves of the pointer step in the coordinates of input.pointer: across the content of the window, from its left edge to its right edge at its middle. */
export function pointerPath({ content }) {
  const left = 1;
  const right = content.width - 1;
  const y = content.height / 2;
  return Array.from({ length: POINTER_MOVES + 1 }, (_, index) => ({ x: left + ((right - left) * index) / POINTER_MOVES, y }));
}

/** Delivers the moves of path with input.pointer of the window of s, each after the answer of the one before it, without activating it. */
async function movePointer(s, path) {
  for (const point of path) await s.request("input.pointer", { ...point, phase: "move" });
}

/**
 * The pointer step of G2 and G8 in the window of the session s, already the key window and not occluded, because input.pointer refuses
 * a move in another window (1006). It takes no permission, activates nothing and leaves the cursor: it measures the moves of input.pointer across the window with measure({ span }), which reads the settled footprints
 * before and after the span and the CPU time over it. It then sets the trace state of the frame records
 * (frameRecords; FRAME_RECORDS of scripts/measure-trace.mjs), repeats the move and, for a window whose host.window reports pageProcess null,
 * reads the U7 records of that move (tail and records), gives them to gestureFigures, and sets the trace state of the measurement again
 * (restore), also when the step fails. It reads frames after the move before diagnostics.log.flush, so the record of every frame that the
 * change of frames counts is in the files that records reads.
 */
export async function measurePointer({ s, measure, frameRecords, restore, tail, records }) {
  const status = await s.get("host.window");
  const path = pointerPath(status);
  const move = await measure({ span: () => movePointer(s, path) });
  await frameRecords();
  let gesture = null;
  try {
    if (status.pageProcess === null) {
      const { frames: framesBefore } = await s.get("host.window");
      const since = await tail();
      await movePointer(s, path);
      const { frames: framesAfter } = await s.get("host.window");
      await s.request("diagnostics.log.flush");
      const read = await records(since);
      gesture = { window: s.window, ...gestureFigures({ ...read, window: s.window, framesBefore, framesAfter }) };
    } else {
      await movePointer(s, path);
    }
  } catch (error) {
    try {
      await restore();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `the pointer step failed (${error.message}) and setting the trace state again failed (${restoreError.message})`);
    }
    throw error;
  }
  await restore();
  return { move, gesture };
}

/** Sets the content of the window of s to size and waits until host.window reports it. */
async function resize(s, { width, height }) {
  await s.run("host.window.resize", { width, height });
  await s.until("host.window", (status) => status.content?.width === width && status.content?.height === height,
    `window ${s.window} did not reach a content of ${width} by ${height} points`);
}

/**
 * Opens one tab of plugin in the first card that is not fixed of the window of s, closes every other tab of the cards that are not
 * fixed, and waits until the tab is ready. Returns { card, tab }.
 */
export async function openOnlyTab(s, plugin) {
  const grid = await s.get("core.grid");
  const cards = Array.isArray(grid?.cards) ? grid.cards.filter((card) => !card.fixed) : [];
  if (cards.length === 0) throw new Error(`core.grid of window ${s.window} has no card that is not fixed: ${JSON.stringify(grid?.cards?.map((card) => card.id))}`);
  const card = cards[0].id;
  const { tab } = await s.run("core.card.add-tab", { card, plugin });
  for (const { tabs } of cards) {
    for (const { id } of tabs ?? []) {
      if (id === tab) continue;
      const { closed } = await s.run("core.tab.close", { tab: id });
      if (closed !== true) throw new Error(`core.tab.close kept tab ${id} of window ${s.window} (closed ${closed})`);
    }
  }
  await s.until("core.surfaces", (list) => list.some((surface) => surface.surface === tab && surface.status?.phase === "ready"),
    `the ${plugin} tab ${tab} of window ${s.window} did not become ready`);
  return { card, tab };
}

/** Opens a new window of the application and returns a session of it once host.windows reports it ready. */
export async function newWindow(s) {
  const known = new Set((await s.get("host.windows")).map((entry) => entry.window));
  await s.run("core.window.new");
  const isNew = (entry) => entry.ready && !known.has(entry.window);
  const list = await s.until("host.windows", (windows) => windows.some(isNew), "core.window.new opened no window that became ready");
  return s.on(list.find(isNew).window);
}

/** S0 and S14 start from one window on the library screen without a plugin view. */
async function requireLibrary(s, state) {
  const windows = await s.get("host.windows");
  if (windows.length !== 1) throw new Error(`${state} requires one window; the application has ${windows.length}`);
  const { screen } = await s.get("core.screen");
  if (screen !== "library") throw new Error(`${state} requires the library screen; window ${s.window} shows ${screen}`);
  const surfaces = await s.get("core.surfaces");
  if (surfaces.length > 0) {
    throw new Error(`${state} requires a window without plugin views; window ${s.window} shows ${surfaces.map((surface) => surface.surface).join(", ")}`);
  }
}

/**
 * S0b: closes the project of the window, waits with diagnostics.process.exit for each WebContent process of a view page or a document
 * region that host.window listed before the close, and returns them with the WebKit processes that remain (G1).
 */
async function closeProject(s, deps) {
  const project = await s.get("core.project");
  if (typeof project?.id !== "string") throw new Error(`S0b requires a window that shows a project; window ${s.window} shows ${JSON.stringify(project)}`);
  const { documents } = await s.get("host.window");
  if (!Array.isArray(documents)) throw new Error(`host.window of window ${s.window} has no documents array`);
  const exited = [...new Set(documents.map((document) => {
    if (!Number.isInteger(document.process) || document.process <= 0) {
      throw new Error(`document ${document.surface}/${document.document} of window ${s.window} has no process (${JSON.stringify(document.process)})`);
    }
    return document.process;
  }))];
  const { closed } = await s.run("core.project.close", { id: project.id });
  if (closed !== true) throw new Error(`core.project.close kept the project ${project.id} (closed ${closed})`);
  for (const pid of exited) await s.request("diagnostics.process.exit", { pid });
  const { screen } = await s.get("core.screen");
  if (screen !== "library") throw new Error(`S0b requires the library screen after the close; window ${s.window} shows ${screen}`);
  return { exited, remaining: await deps.remainingWebKit() };
}

/**
 * S1: the fixture project with one term tab and, beside it, one browser tab on the blank page of the loopback server of deps.serve().
 * The trace state is set after the fixture, which resets the common settings. Returns the address of the page.
 */
async function prepareS1(s, deps) {
  await s.request("diagnostics.fixture");
  await deps.applyTrace();
  const { card } = await openOnlyTab(s, S1_TERMINAL);
  const url = await deps.serve();
  const { tab } = await s.run("core.card.split", { card, side: "right", plugin: S1_BROWSER });
  await s.until("core.surfaces", (list) => list.some((surface) => surface.surface === tab && surface.exposes?.includes(`status ${S1_BROWSER}.location`)),
    `the browser surface ${tab} did not register ${S1_BROWSER}.location`);
  await s.run(`${S1_BROWSER}.navigate`, { url }, tab);
  await s.until(`${S1_BROWSER}.location`, (at) => at.url === url && !at.loading && at.error === null && at.title === "blank",
    `surface ${tab} did not load ${url}`, { surface: tab });
  return url;
}

/**
 * Prepares state in the window of the session s through declared commands, in a window of 1200 by 760 points (B3). deps holds
 * applyTrace() (the trace state of the measurement), serve() (the address of the blank page), projectRoot(name) (a project folder),
 * logPosition() and untilFaultLine(position) (the application log), remainingWebKit() (the WebKit processes of the application with their
 * footprints) and sleep(ms). Returns { state, windows, footprints } with the windows of the state, the footprint rule (`settled`, or
 * `at-once` for S14) and the readings of the state: url (S1 and the states after it), exited and remaining (S0b) and faultLog (S12).
 */
export async function prepareState(s, state, deps) {
  if (!STATES.includes(state)) throw new Error(`the state ${state} is not one of ${STATES.join(", ")}`);
  await resize(s, WINDOW_SIZE);
  const context = { state, windows: [s.window], footprints: state === "S14" ? "at-once" : "settled" };
  if (state === "S0b") {
    await deps.applyTrace();
    return { ...context, ...(await closeProject(s, deps)) };
  }
  if (state === "S0" || state === "S14") {
    await deps.applyTrace();
    await requireLibrary(s, state);
    if (state === "S14") {
      await s.run("core.library.search.focus");
      await s.request("input.key", { key: "a", phase: "down" });
      await s.request("input.key", { key: "a", phase: "up" });
      // S14 reads 10 seconds after the key while the caret blinks; no status marks that time.
      await deps.sleep(KEY_READING_MS);
    }
    return context;
  }
  context.url = await prepareS1(s, deps);
  if (state === "S9") {
    const cover = await newWindow(s);
    await resize(cover, { width: WINDOW_SIZE.width + 2 * COVER_MARGIN, height: WINDOW_SIZE.height + 2 * COVER_MARGIN });
    const { frame } = await s.get("host.window");
    await cover.run("host.window.move", { x: frame.x - COVER_MARGIN, y: frame.y - COVER_MARGIN });
    await s.until("host.window", (status) => status.occluded === true, `the second window did not cover window ${s.window}`);
    context.windows.push(cover.window);
  } else if (state === "S11") {
    const second = await newWindow(s);
    await second.run("core.project.open", { root: deps.projectRoot("S11") });
    await resize(second, WINDOW_SIZE);
    const { frame } = await s.get("host.window");
    await second.run("host.window.move", { x: frame.x + frame.width, y: frame.y });
    context.windows.push(second.window);
  } else if (state === "S12") {
    const position = deps.logPosition();
    await s.request("diagnostics.layout.fail");
    await s.run("host.window.resize", { width: WINDOW_SIZE.width - FAULT_RESIZE, height: WINDOW_SIZE.height });
    await deps.untilFaultLine(position);
    await resize(s, WINDOW_SIZE);
    context.faultLog = position;
  } else if (state === "S15") {
    await s.run("core.settings.open");
    await s.until("core.settings-modal", (modal) => modal?.open === true, `the settings window of window ${s.window} did not open`);
  }
  return context;
}

function megabytes(bytes) {
  return bytes === null || bytes === undefined ? "error" : (bytes / 1_000_000).toFixed(1);
}

function seconds(value) {
  return value === null || value === undefined ? "error" : value.toFixed(2);
}

function percent(value) {
  return value === null || value === undefined ? "error" : value.toFixed(1);
}

function formatTable(rows, totals) {
  const after = rows.some((row) => "bytesAfter" in row);
  const cells = (row) => [
    megabytes(row.bytes), ...(after ? [megabytes(row.bytesAfter)] : []), megabytes(row.peakBytes), seconds(row.cpuSeconds), percent(row.cpuPercent),
  ];
  const lines = [
    ["role", "pid", "attribution", "MB", ...(after ? ["MB after"] : []), "peak MB", "cpu s", "cpu%"],
    ...rows.map((row) => [row.role, String(row.pid), row.attribution, ...cells(row)]),
    ["application", "", "without sidecars", ...cells(totals.application)],
    ["sidecars", "", "", ...cells(totals.sidecars)],
    ["total", "", "", ...cells(totals.total)],
  ];
  const widths = lines[0].map((_, column) => Math.max(...lines.map((line) => line[column].length)));
  return lines
    .map((line) => line.map((cell, column) => (column === 0 || column === 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  "))
    .join("\n");
}

function formatMarks(when, marks) {
  return marks.flatMap(({ configDir, trace, policy, windows }) => [
    `${when}: ${configDir}: trace switch ${trace}, log policy ${JSON.stringify(policy)}`,
    ...windows.map(({ window, occluded, frames, commandBuffers, runtime, scale, refreshRate }) =>
      `  window ${window}: occluded ${occluded}, frames ${frames}, commandBuffers ${commandBuffers}, scale ${scale}, refreshRate ${refreshRate}, ` +
        `runtime ${JSON.stringify(runtime)}`),
  ]).join("\n");
}

function formatReport({ options, context, measurement, gesture, faultLines, idle, recordsOverCpu }) {
  const sections = [`state ${options.state ?? "none"}, trace ${options.trace}, idle ${options.idle ? 1 : 0}, step ${options.step ?? "none"}`];
  if (context?.exited) {
    sections.push([`exited webcontent processes: ${context.exited.join(", ") || "none"}`,
      "webkit processes that remain:", ...context.remaining.map(({ role, pid, bytes }) => `  ${role} ${pid} ${megabytes(bytes)} MB`)].join("\n"));
  }
  if (measurement.marks.before) sections.push(formatMarks("before the first cpu reading", measurement.marks.before));
  for (const app of measurement.apps) sections.push(`app ${app.configDir} (cpu over ${measurement.seconds.toFixed(2)} s)\n${formatTable(app.rows, app.totals)}`);
  sections.push(`webkit processes not attributed to an application\n${formatTable(measurement.unattributed.rows, measurement.unattributed.totals)}`);
  if (measurement.marks.after) sections.push(formatMarks("after the last cpu reading", measurement.marks.after));
  if (measurement.marks.before && measurement.marks.after) {
    const windowsOf = (marks) => marks.flatMap(({ windows }) => windows);
    const lines = notMeasuredLines({ idle, marks: { before: windowsOf(measurement.marks.before), after: windowsOf(measurement.marks.after) } });
    if (lines.length > 0) sections.push(lines.join("\n"));
  }
  if (faultLines !== undefined) sections.push(`error lines of the layout fault: ${faultLines}`);
  if (recordsOverCpu !== undefined) sections.push(`records written over the cpu interval: ${recordsOverCpu}`);
  if (gesture !== undefined) {
    sections.push(gesture === null
      ? "pointer move under the trace state of the frame records: the window has a main page and no U7 records"
      : `pointer move under the trace state of the frame records, window ${gesture.window}: mouseMoved: step with a hitTest: step right before it p90 ${gesture.p90Ms.toFixed(2)} ms ` +
        `over ${gesture.moves} moves, ${gesture.frameRecords} frame records for a change of frames of ${gesture.framesChange}`);
  }
  return sections.join("\n\n");
}

/** The keys of the B3 output of the trace states 0 and 1; an output holds a subset of them (the header states when each is present). */
const RUN_MEASUREMENTS = Object.freeze([
  "hostCpuSeconds", "applicationCpuSeconds", "sidecarCpuSeconds", "hostFootprintKb", "applicationFootprintKb", "sidecarFootprintKb",
  "applicationFootprintAfterKb", "applicationPeakFootprintKb", "webKitProcesses", "webContentProcesses", "frames", "commandBuffers",
  "errorLines",
]);

/**
 * The keys of the B3 output of make measure-app-usage for each trace state that TRACE takes: one output holds the keys of one trace state, and
 * the trace state of the frame records (FRAME_RECORDS, with --step pointer) gives pointerMoveP90Ms alone.
 */
export const B3_MEASUREMENTS = Object.freeze({ 0: RUN_MEASUREMENTS, 1: RUN_MEASUREMENTS, [FRAME_RECORDS]: Object.freeze(["pointerMoveP90Ms"]) });

/** The bytes of a KB, the unit of the footprints of a B3 record. */
const KB = 1024;

/** The WebContent processes of an application: its page and document processes and the WebContent services of its launchd domain. */
const webContentRow = ({ role }) => role.startsWith("page ") || role.startsWith("document ") || role === "webkit webcontent";

/**
 * The change of the frame counter `name` (frames or commandBuffers of host.window) over the CPU interval, summed over the windows of the
 * marks; undefined on a host whose host.window reports the counter null in every window (a host with a main page).
 */
function counterChange(name, marks) {
  const pairs = marks.before.map((mark) => {
    const later = marks.after.find(({ window }) => window === mark.window);
    if (later === undefined) throw new Error(`window ${mark.window} has no mark after the last cpu reading`);
    return [mark.window, mark[name], later[name]];
  });
  if (pairs.every(([, first, last]) => first === null && last === null)) return undefined;
  return pairs.reduce((sum, [window, first, last]) => {
    if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) {
      throw new Error(`window ${window} reports ${name} ${JSON.stringify(first)} before the first and ${JSON.stringify(last)} after the last cpu reading`);
    }
    return sum + last - first;
  }, 0);
}

/**
 * The measurements of a B3 record of make measure-app-usage (the keys that the header declares) from one application of measureApps (app), the
 * window marks of that application before and after the CPU interval (marks), the error lines of the layout fault of S12 (faultLines)
 * and the figures of the pointer step (gesture).
 */
export function usageMeasurements({ app, marks, faultLines, gesture }) {
  const host = app.rows.find(({ role }) => role === "host");
  if (host === undefined) throw new Error(`${app.configDir} has no host row`);
  const { application, sidecars } = app.totals;
  const measured = {
    hostCpuSeconds: host.cpuSeconds,
    applicationCpuSeconds: application.cpuSeconds,
    sidecarCpuSeconds: sidecars.cpuSeconds,
    hostFootprintKb: host.bytes / KB,
    applicationFootprintKb: application.bytes / KB,
    sidecarFootprintKb: sidecars.bytes / KB,
    applicationPeakFootprintKb: application.peakBytes / KB,
    webKitProcesses: app.rows.filter((row) => webContentRow(row) || row.role.startsWith("webkit ")).length,
    webContentProcesses: app.rows.filter(webContentRow).length,
  };
  if ("bytesAfter" in application) measured.applicationFootprintAfterKb = application.bytesAfter / KB;
  for (const name of ["frames", "commandBuffers"]) {
    const change = counterChange(name, marks);
    if (change !== undefined) measured[name] = change;
  }
  if (faultLines !== undefined) measured.errorLines = faultLines;
  if (gesture) measured.pointerMoveP90Ms = gesture.p90Ms;
  return measured;
}

/** Reads --b3-out: an absolute path, or null without the option. */
export function b3OutOption(value) {
  if (value === undefined) return null;
  if (!isAbsolute(value)) throw new Error(`--b3-out must be an absolute path (${value})`);
  return value;
}

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      sok: { type: "string" },
      "config-dir": { type: "string", multiple: true },
      interval: { type: "string", default: "10" },
      state: { type: "string" },
      idle: { type: "boolean", default: false },
      step: { type: "string" },
      trace: { type: "string" },
      "b3-out": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.sok || !values["config-dir"]) throw new Error("required options: --sok PATH --config-dir DIR [--config-dir DIR ...] --trace 0|1|frame-records");
  for (const configDir of values["config-dir"]) {
    if (!isAbsolute(configDir)) throw new Error(`--config-dir must be an absolute path (${configDir})`);
  }
  const interval = Number(values.interval);
  if (!(interval > 0)) throw new Error(`--interval must be a positive number of seconds (${values.interval})`);
  const trace = parseTrace(values.trace, [0, 1, FRAME_RECORDS]);
  if (values.state !== undefined && !STATES.includes(values.state)) throw new Error(`--state must be one of ${STATES.join(", ")} (${values.state})`);
  if (values.step !== undefined && values.step !== "pointer") throw new Error(`--step must be pointer (${values.step})`);
  if (trace === FRAME_RECORDS && values.step === undefined) {
    throw new Error(`TRACE ${FRAME_RECORDS} is the trace state of the U7 records of --step pointer, which was not given`);
  }
  if ((values.state !== undefined || values.idle || values.step !== undefined) && values["config-dir"].length !== 1) {
    throw new Error(`--state, --idle and --step prepare and measure one application; ${values["config-dir"].length} --config-dir were given`);
  }
  const b3Out = b3OutOption(values["b3-out"]);
  if (b3Out !== null && values["config-dir"].length !== 1) throw new Error(`--b3-out records one application; ${values["config-dir"].length} --config-dir were given`);
  return {
    sok: values.sok, configDirs: values["config-dir"], interval, state: values.state ?? null, idle: values.idle,
    step: values.step ?? null, trace, b3Out, json: values.json,
  };
}

/** Runs a command and resolves to the process result {status, stdout, stderr, error} that launchdServices reads. */
export function execute(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr, error: error && typeof error.code !== "number" ? error : undefined });
    });
  });
}

/** The standard output of a command that must succeed; a failure names the command and its output. */
async function outputOf(run, command, args) {
  const result = await run(command, args);
  if (result.error) throw new Error(`${command} ${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}: ${String(result.stderr).trim()}`);
  return result.stdout;
}

/** The CPU seconds of every process, as a map from pid to seconds, from ps -axo pid=,time=; run is the executor of execute. */
export async function readCpuSeconds(run) {
  return parseCpuSamples(await outputOf(run, "ps", ["-axo", "pid=,time="]));
}

/** The running WebKit GPU and networking processes of every application, as { pid, role }. pgrep exits with 1 when none runs. */
async function webkitPids(run) {
  const found = [];
  for (const name of ["GPU", "Networking"]) {
    const result = await run("pgrep", ["-f", `com.apple.WebKit.${name}`]);
    if (result.status === 1) continue;
    if (result.error || result.status !== 0) throw new Error(`pgrep failed: ${result.error?.message ?? String(result.stderr).trim()}`);
    for (const pid of result.stdout.split("\n").filter((line) => line !== "")) found.push({ pid: Number(pid), role: `webkit ${name.toLowerCase()}` });
  }
  return found;
}

/** The host.window reply of a window through sok. */
async function windowStatus(text, sok, configDir, window) {
  return JSON.parse(await text(sok, ["status", "host.window", "--window", window, "--config-dir", configDir]));
}

/**
 * The processes of the application of the configuration folder configDir, each as { role, pid, attribution }: its host, the process whose
 * command line has --config-dir configDir, its sidecars, the processes whose executable is under configDir/sidecars/, and the WebKit
 * GPU, networking and WebContent services of the launchd domain of its host. A missing or duplicate host and a launchd domain that
 * cannot be read are errors. run(command, args) resolves to {status, stdout, stderr, error}, and realpath(path) is the real path.
 */
export async function applicationRows({ configDir, run = execute, realpath = realpathSync }) {
  const table = parseProcessTable(await outputOf(run, "ps", ["-axww", "-o", "pid=,command="]));
  const realPath = realpath(configDir);
  let host;
  try {
    host = hostProcess(table, configDir, realPath);
  } catch (error) {
    throw new Error(`host of ${configDir}: ${error.message}`);
  }
  const webkit = await attributeWebKit([{ configDir, pid: host.pid }], run);
  if (webkit.errors.length > 0) throw new Error(webkit.errors.join("; "));
  return [
    { role: "host", pid: host.pid, attribution: "config-dir argument" },
    ...sidecarProcesses(table, configDir, realPath),
    ...webkit.attributed.map(({ role, pid, attribution }) => ({ role, pid, attribution })),
  ];
}

/**
 * The processes of the application of configDir with its windows: the rows of applicationRows and the page and document rows of each
 * window (windowRows) from statuses, the host.window replies of its windows, each carrying `window`, its identifier. A page or document
 * process that host.window reports is a row of its window, so the WebKit row of the launchd domain with the same pid is left out. The
 * errors are those of windowRows.
 */
export async function windowApplicationRows({ configDir, statuses, run = execute, realpath = realpathSync }) {
  const listed = await applicationRows({ configDir, run, realpath });
  const shown = [];
  const errors = [];
  for (const status of statuses) {
    const found = windowRows(status.window, configDir, status);
    shown.push(...found.rows);
    errors.push(...found.errors);
  }
  const webkit = ({ attribution }) => attribution === "launchd domain";
  return {
    rows: [
      ...listed.filter((row) => !webkit(row)),
      ...shown,
      ...listed.filter((row) => webkit(row) && !shown.some(({ pid }) => pid === row.pid)),
    ],
    errors,
  };
}

/** The windows of one application with the host.window reply of each window, which carries `window`, its identifier. */
async function windowStatuses(configDir, sok, errors, text) {
  const statuses = [];
  let windows = [];
  try {
    windows = JSON.parse(await text(sok, ["windows", "--config-dir", configDir])).map(({ window }) => window);
  } catch (error) {
    errors.push(`windows of ${configDir}: ${error.message}`);
  }
  for (const window of windows) {
    let status;
    try {
      status = await windowStatus(text, sok, configDir, window);
    } catch (error) {
      errors.push(`page of window ${window} of ${configDir}: ${error.message}`);
      continue;
    }
    statuses.push({ ...status, window });
  }
  return { statuses, windows };
}

/**
 * Measures the processes of the applications of configDirs. footprints is `settled` (read after the settle rule of G3) or `at-once`;
 * settleAfter also reads the settled footprints after the span as bytesAfter. span() is the interval of the CPU readings, by default
 * INTERVAL seconds; marks.before() and marks.after() run right before the first and right after the last CPU reading, and their results
 * are returned as marks. The peak footprint of each process is read after the last CPU reading. run(command, args), sleep(ms) and
 * realpath(path) are the process executor, the timer and the real path, which the tests replace.
 */
export async function measureApps({
  sok, configDirs, interval, footprints = "settled", settleAfter = false, span, marks, beforeCpu, afterCpu,
  run = execute, sleep = delay, realpath = realpathSync,
}) {
  if (footprints !== "settled" && footprints !== "at-once") throw new Error(`footprints must be settled or at-once, not ${JSON.stringify(footprints)}`);
  const errors = [];
  const text = (command, args) => outputOf(run, command, args);
  const apps = [];
  const claimed = new Set();
  for (const configDir of configDirs) {
    const shown = await windowStatuses(configDir, sok, errors, text);
    const { rows, errors: rowErrors } = await windowApplicationRows({ configDir, statuses: shown.statuses, run, realpath });
    errors.push(...rowErrors);
    // The WebKit GPU and networking processes of the launchd domain belong to the application, so pgrep does not list them as unattributed.
    for (const row of rows.filter(({ attribution }) => attribution === "launchd domain")) claimed.add(row.pid);
    apps.push({ configDir, rows, windows: shown.windows });
  }
  const unattributed = (await webkitPids(run))
    .filter(({ pid }) => !claimed.has(pid))
    .map(({ pid, role }) => ({ role, pid, attribution: "unattributed" }));

  const groups = [...apps.map((app) => ({ name: app.configDir, rows: app.rows })), { name: "unattributed", rows: unattributed }];
  const measured = groups.flatMap(({ name, rows }) => rows.map((row) => ({ row, where: `${name} ${row.role} (pid ${row.pid})` })));
  const readCpu = () => readCpuSeconds(run);
  // A process of no application that ends during the measurement is no failure of the application and leaves the list.
  const foreign = new Set(unattributed.map(({ pid }) => pid));
  const ended = new Set();
  // A process whose footprint cannot be read is reported once, whatever the number of readings.
  const failures = new Set();
  // A process of no application whose footprint cannot be read is judged by the process table at the end of the measurement: footprint
  // stops finding a process that ends before the process table drops it.
  const unread = new Map();
  const footprintOf = async ({ row, where }) => {
    if (ended.has(row.pid)) return null;
    try {
      return await readFootprint(row.pid, run);
    } catch (error) {
      if (!foreign.has(row.pid)) failures.add(`${where}: ${error.message}`);
      else if (!unread.has(row.pid)) unread.set(row.pid, `${where}: ${error.message}`);
      return null;
    }
  };
  const readFootprints = async () => {
    const values = new Map();
    for (const entry of measured) {
      const reading = await footprintOf(entry);
      if (reading !== null) values.set(entry.row.pid, reading.bytes);
    }
    return values;
  };
  const readFrames = async () => {
    const frames = [];
    for (const app of apps) for (const window of app.windows) frames.push((await windowStatus(text, sok, app.configDir, window)).frames);
    return frames;
  };
  const first = footprints === "settled"
    ? await settledFootprints({ readFootprints, readFrames, sleep })
    : { footprints: await readFootprints() };
  for (const { row } of measured) row.bytes = first.footprints.get(row.pid) ?? null;

  const before = marks ? await marks.before() : undefined;
  if (beforeCpu) await beforeCpu();
  const cpuBefore = await readCpu();
  const started = performance.now();
  if (span) await span();
  // The fixed sampling interval is the measurement itself; no status notification marks the end of a CPU interval.
  else await sleep(interval * 1000);
  const cpuAfter = await readCpu();
  if (afterCpu) await afterCpu();
  const elapsed = span ? (performance.now() - started) / 1000 : interval;
  const after = marks ? await marks.after() : undefined;
  for (const { row, where } of measured) {
    if (!cpuBefore.has(row.pid) || !cpuAfter.has(row.pid)) {
      if (foreign.has(row.pid)) {
        ended.add(row.pid);
        continue;
      }
      errors.push(`${where}: pid is not in the process table at both cpu reads`);
      row.cpuSeconds = null;
      row.cpuPercent = null;
      continue;
    }
    try {
      row.cpuPercent = cpuPercent(cpuBefore.get(row.pid), cpuAfter.get(row.pid), elapsed);
      row.cpuSeconds = cpuAfter.get(row.pid) - cpuBefore.get(row.pid);
    } catch (error) {
      errors.push(`${where}: ${error.message}`);
      row.cpuSeconds = null;
      row.cpuPercent = null;
    }
  }
  if (settleAfter) {
    const later = await settledFootprints({ readFootprints, readFrames, sleep });
    for (const { row } of measured) row.bytesAfter = later.footprints.get(row.pid) ?? null;
  }
  for (const entry of measured) {
    entry.row.peakBytes = (await footprintOf(entry))?.peakBytes ?? null;
  }
  if (unread.size > 0) {
    const last = await readCpu();
    for (const [pid, failure] of unread) {
      if (last.has(pid)) failures.add(failure);
      else ended.add(pid);
    }
  }
  errors.push(...failures);
  const remaining = unattributed.filter(({ pid }) => !ended.has(pid));

  return {
    seconds: elapsed,
    apps: apps.map((app) => ({ configDir: app.configDir, windows: app.windows, rows: app.rows, totals: totalsOf(app.rows) })),
    unattributed: { rows: remaining, totals: totalsOf(remaining) },
    marks: { before, after },
    errors,
  };
}

/** The event catalog of this repository with the catalogs of the sidecars installed in the configuration folder. */
const CATALOG = fileURLToPath(new URL("../docs/spec/events.json", import.meta.url));

/** All rows of a log.query, page by page. */
async function queryRows(client, query) {
  const rows = [];
  for (let after; ;) {
    const page = await client.request("log.query", after === undefined ? query : { ...query, after });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** The greatest seq of each process of the log now (the tail of log.query). */
async function logTail(client) {
  return (await client.request("log.query", { channel: "all", order: "desc", limit: 1 })).tail;
}

/** The name `<role>-<boot>` of the host process pid among the processes of a log tail. */
function hostName(tail, pid) {
  const names = Object.keys(tail).filter((name) => name.startsWith("host-") && name.endsWith(`-${pid}`));
  if (names.length !== 1) throw new Error(`the log tail names ${names.length} processes of the host ${pid}: ${Object.keys(tail).join(", ")}`);
  return names[0];
}

/** The state of one window before or after the CPU readings: occluded, the frame counters and the runtime figures of diagnostics.objects. */
async function windowMark(s) {
  const status = await s.get("host.window");
  const objects = await s.request("diagnostics.objects");
  // The Tauri host has no garbage-collected runtime and reports no runtime member (docs/spec/endpoint.md).
  return {
    window: s.window, occluded: status.occluded, active: status.active, frames: status.frames, commandBuffers: status.commandBuffers, runtime: objects.runtime ?? null,
    scale: status.scale, refreshRate: status.refreshRate, content: status.content,
  };
}

/** Measures the applications of the options and returns the parts of the report. */
async function measureOptions(options) {
  const { sok, configDirs, interval, state, idle, step, trace } = options;
  const cleanups = [];
  const errors = [];
  const sessions = [];
  try {
    for (const configDir of configDirs) {
      const client = await connect({ configDir });
      cleanups.push(() => client.close());
      const s = new Session({ name: basename(configDir), configDir }, client);
      const windows = await client.request("windows.list");
      if (!Array.isArray(windows) || windows.length === 0) throw new Error(`${configDir} lists no window`);
      if (state !== null && windows.length !== 1) throw new Error(`--state starts from one window; ${configDir} has ${windows.length}`);
      s.window = windows[0].window;
      sessions.push({ configDir, client, s, windows: windows.map(({ window }) => window) });
    }
    const traceOf = ({ s, configDir }) => () => applyTrace((name, params) => s.run(name, params), trace, configDir);
    let context = null;
    if (state !== null) {
      const [{ configDir, client, s }] = sessions;
      const catalog = catalogOf(JSON.parse(readFileSync(CATALOG, "utf8")), configDir);
      context = await prepareState(s, state, {
        applyTrace: traceOf(sessions[0]),
        serve: async () => {
          const server = createServer((request, response) => {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            response.end("<!doctype html><title>blank</title>");
          });
          await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
          cleanups.push(() => new Promise((resolve) => server.close(resolve)));
          return `http://127.0.0.1:${server.address().port}/blank`;
        },
        projectRoot: (name) => {
          // The project folder of a second window lives in the disposable configuration folder of the measured application.
          const root = join(configDir, "app-usage-projects", name);
          mkdirSync(root, { recursive: true });
          return root;
        },
        logPosition: () => currentEventOffsets(configDir),
        untilFaultLine: (position) => untilEventLine(configDir, position, (line) => faultErrorCount([line]) === 1, FAULT_LINE_LIMIT,
          { catalog, records: ["host.record.error", "workbench.record.error"] }),
        remainingWebKit: async () => {
          const remaining = [];
          for (const { role, pid } of (await applicationRows({ configDir })).filter(({ attribution }) => attribution === "launchd domain")) {
            remaining.push({ role, pid, bytes: (await readFootprint(pid, execute)).bytes });
          }
          return remaining;
        },
        sleep: delay,
      });
      sessions[0].windows = context.windows;
    } else {
      for (const session of sessions) await traceOf(session)();
    }
    const windowSessions = sessions.flatMap(({ s, windows }) => windows.map((window) => s.on(window)));
    const frames = async () => {
      const values = [];
      for (const s of windowSessions) values.push((await s.get("host.window")).frames);
      return values;
    };
    const marksOf = async () => {
      const marks = [];
      for (const { configDir, s, windows } of sessions) {
        const { values } = await s.get("core.settings");
        const readings = [];
        for (const window of windows) readings.push(await windowMark(s.on(window)));
        marks.push({ configDir, trace: values["diagnostics.performance"], policy: readPolicy(configDir).classes, windows: readings });
      }
      return marks;
    };
    for (const mark of await marksOf()) requireOcclusion(state, mark.windows);
    const idleResult = idle ? await waitIdle({ sessions: windowSessions, frames, sleep: delay }) : null;
    let lines;
    let recordsOverCpu;
    const settled = !idle ? {} : {
      beforeCpu: async () => {
        await delay(COUNT_WAIT_MS);
        lines = configDirs.map(logLineCounts);
      },
      afterCpu: async () => {
        recordsOverCpu = configDirs.reduce((sum, configDir, index) => sum + recordsOver(lines[index], logLineCounts(configDir)), 0);
      },
    };
    const measure = (extra) => measureApps({
      sok, configDirs, interval, footprints: context?.footprints ?? "settled", marks: { before: marksOf, after: marksOf }, ...settled, ...extra,
    });
    let measurement;
    let gesture;
    if (step === "pointer") {
      const [{ configDir, client, s }] = sessions;
      const pid = client.endpoint.pid;
      const pointer = await measurePointer({
        s,
        measure: ({ span }) => measure({ span, settleAfter: true }),
        frameRecords: () => applyTrace((name, params) => s.run(name, params), FRAME_RECORDS, configDir),
        restore: traceOf(sessions[0]),
        tail: () => logTail(client),
        records: async (since) => {
          const name = hostName(since, pid);
          const own = (rows) => rows.filter((row) => `${row.role}-${row.boot}` === name).map((row) => row.event);
          const records = [];
          for (const event of [U7_EVENTS.frame, U7_EVENTS.step]) records.push(...own(await queryRows(client, { channel: "all", event, since })));
          const dropped = own(await queryRows(client, { channel: "all", event: "log.dropped", since }));
          return { records, dropped, fromSeq: since[name], toSeq: (await logTail(client))[name] };
        },
      });
      measurement = pointer.move;
      gesture = pointer.gesture;
    } else {
      measurement = await measure({});
    }
    errors.push(...measurement.errors);
    for (const mark of measurement.marks.after) {
      try {
        requireOcclusion(state, mark.windows);
      } catch (error) {
        errors.push(`after the last cpu reading: ${error.message}`);
      }
    }
    let faultLines;
    if (context?.faultLog) {
      await sessions[0].s.request("diagnostics.log.flush");
      faultLines = faultErrorCount(readEventErrors(sessions[0].configDir, context.faultLog).errors);
    }
    return { options, context, measurement, gesture, faultLines, errors, idle: idleResult, recordsOverCpu };
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

/**
 * The B3 output {measurements, conditions} of a measurement of make measure-app-usage. One output holds the keys of one trace state, the state of
 * its measured interval: with --step pointer, the trace state 0 or 1 gives the keys of the first move without pointerMoveP90Ms, and the trace
 * state FRAME_RECORDS gives pointerMoveP90Ms alone, from the repeated move in that state. The conditions come from b3Conditions of
 * scripts/b3-out.mjs with the window marks of the application before the first CPU reading, which carry the id, the refresh rate, the
 * scale and the content of each window, the diagnostics.performance of the trace state and the classes of the policy in force before
 * that reading.
 */
export function usageOutput({ options, measurement, gesture, faultLines }) {
  const [app] = measurement.apps;
  const [before] = measurement.marks.before;
  const [after] = measurement.marks.after;
  let measurements;
  if (options.trace === FRAME_RECORDS) {
    if (gesture === null || gesture === undefined) {
      throw new Error(`the pointer output under the trace state ${FRAME_RECORDS} is pointerMoveP90Ms, which a window with a main page has not`);
    }
    measurements = { pointerMoveP90Ms: gesture.p90Ms };
  } else {
    measurements = usageMeasurements({ app, marks: { before: before.windows, after: after.windows }, faultLines, gesture: null });
  }
  const conditions = b3Conditions({ windows: before.windows.map((window, index) => ({ ...window, ...b3End(window, after.windows[index]) })), performance: traceSettings(options.trace)["diagnostics.performance"], policy: before.policy });
  return { measurements, conditions };
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await measureOptions(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReport(result));
    for (const error of result.errors) console.error(`error: ${error}`);
    if (result.errors.length > 0) process.exitCode = 1;
    // A measurement with an error records no B3 values: its figures miss a process or a window.
    else if (options.b3Out !== null) writeB3Out(options.b3Out, usageOutput(result));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
