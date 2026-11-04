// Measures the allocations of the host process of a running application at start and after each minute.
//
// The host is the one application process whose command line has --config-dir DIR, found as `make app-usage` finds it
// (hostProcess of scripts/measure-app-usage.mjs), so the measurement names the application and not a process id. Before the
// first reading it sets the trace state of TRACE through the sok of the application (scripts/measure-trace.mjs). The
// allocations are the live nodes and bytes of every malloc zone that `heap` reports for the process ("All zones: N nodes
// (B bytes)"), and the footprint is the phys_footprint of the process (readFootprint of scripts/footprints.mjs). The interval
// waits for no event, so it is set by duration. Each step prints {phase, elapsedMs, pid, nodes, bytes, footprint} as one JSON
// line; after the last minute the footprint is read until it settles by the rule of G3 (settledFootprints of
// scripts/footprints.mjs, with the frames of every window of the application) and printed as {phase: "settled", elapsedMs, pid,
// footprint}. It makes no judgment. With --b3-out FILE, which needs the 60 minutes of S4, it writes the B3 output of S4
// (scripts/b3-out.mjs) with the measurement that B3_MEASUREMENTS declares, hostFootprintKb, the settled footprint in KB, and the
// conditions of the windows. `make host-allocations` runs it.
//
//   node scripts/measure-host-allocations.mjs --sok PATH --config-dir DIR --trace 0|1 [--minutes N] [--b3-out FILE]
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readPolicy } from "@soksak/window-check/log-policy.mjs";
import { b3Conditions, writeB3Out } from "./b3-out.mjs";
import { readFootprint, settledFootprints } from "./footprints.mjs";
import { hostProcess, parseProcessTable } from "./measure-app-usage.mjs";
import { applyTrace, parseTrace, traceSettings } from "./measure-trace.mjs";

/** The keys of the B3 output of host-allocations (scripts/b3-out.mjs), which b3Output gives. */
export const B3_MEASUREMENTS = Object.freeze(["hostFootprintKb"]);

/** The minutes of S4 of B3: S1 for 60 minutes without input. */
const B3_MINUTES = 60;

/** The bytes of a KB, the unit of hostFootprintKb. */
const KB = 1024;

/** The live nodes and bytes of all zones in the output of `heap`; output without the totals line is an error that quotes its start. */
export function heapTotals(text) {
  const match = /^All zones: (\d+) nodes \((\d+) bytes\)$/m.exec(text);
  if (match === null) throw new Error(`heap printed no line "All zones: N nodes (B bytes)": ${text.slice(0, 200)}`);
  return { nodes: Number(match[1]), bytes: Number(match[2]) };
}

/**
 * Records the totals and the footprint (footprint(pid), in bytes) at start and after each of `minutes` intervals, then reads the
 * footprint until it settles by the rule of G3 with the frames of the windows (readFrames()) and records it; returns the settled
 * footprint in bytes. wait(ms) waits, for the minutes and for the readings of the settle rule.
 */
export async function measure({ pid, minutes, totals, footprint, readFrames, wait, log, now = Date.now }) {
  const started = now();
  log({ phase: "start", elapsedMs: 0, pid, ...totals(pid), footprint: await footprint(pid) });
  for (let minute = 1; minute <= minutes; minute++) {
    await wait(60_000);
    log({ phase: `minute ${minute}`, elapsedMs: now() - started, pid, ...totals(pid), footprint: await footprint(pid) });
  }
  const { footprints } = await settledFootprints({ readFootprints: async () => new Map([[pid, await footprint(pid)]]), readFrames, sleep: wait });
  const settled = footprints.get(pid);
  log({ phase: "settled", elapsedMs: now() - started, pid, footprint: settled });
  return settled;
}

/**
 * The frames of the windows from their host.window replies, each with the id of its window in the member `window`: a count, or null on
 * a host whose host.window counts no frame. Another value is an error that names the window.
 */
export function windowFrames(replies) {
  return replies.map(({ window, frames }) => {
    if (frames !== null && !(Number.isInteger(frames) && frames >= 0)) {
      throw new Error(`window ${window} reports frames ${JSON.stringify(frames)}, not a count or null`);
    }
    return frames;
  });
}

/**
 * The B3 output of S4 from the settled footprint of the host in bytes, the host.window replies of the windows of the application
 * (each with its window id in `window`, the window of the state first), the trace state that TRACE set and the classes of the
 * policy in force: hostFootprintKb and the conditions of b3Conditions, whose traceState is the diagnostics.performance of TRACE.
 */
export function b3Output({ settledBytes, windows, trace, policy }) {
  return {
    measurements: { hostFootprintKb: settledBytes / KB },
    conditions: b3Conditions({ windows, performance: traceSettings(trace)["diagnostics.performance"], policy }),
  };
}

/**
 * Finds the host process of the configuration folder in the rows `processes` of the process table and then sets the trace
 * state through `run(command, params)`; returns the process id of the host. realPath is the real path of the folder.
 */
export async function prepare({ processes, configDir, realPath, run, trace }) {
  const { pid } = hostProcess(processes, configDir, realPath);
  await applyTrace(run, trace, configDir);
  return pid;
}

/** The command line options. */
export function parseOptions(args) {
  const { values } = parseArgs({
    args, strict: true,
    options: {
      sok: { type: "string" }, "config-dir": { type: "string" }, trace: { type: "string" }, minutes: { type: "string", default: "10" },
      "b3-out": { type: "string" },
    },
  });
  const trace = parseTrace(values.trace);
  if (!values.sok || !values["config-dir"]) throw new Error("required options: --sok PATH --config-dir DIR");
  const minutes = Number(values.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error(`--minutes must be a positive integer, got ${values.minutes}`);
  const b3Out = values["b3-out"] ?? null;
  if (b3Out === "") throw new Error("--b3-out must name a file");
  if (b3Out !== null && minutes < B3_MINUTES) throw new Error(`--b3-out needs at least ${B3_MINUTES} minutes, the minutes of S4, not ${minutes}`);
  return { sok: values.sok, configDir: values["config-dir"], trace, minutes, b3Out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sok, configDir, trace, minutes, b3Out } = parseOptions(process.argv.slice(2));
  const reply = (args) => JSON.parse(execFileSync(sok, [...args, "--config-dir", configDir], { encoding: "utf8" }));
  const pid = await prepare({
    processes: parseProcessTable(execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" })),
    configDir, realPath: realpathSync(configDir), trace,
    run: async (command, params) => reply([command, "--params", JSON.stringify(params)]),
  });
  const listed = reply(["windows"]);
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new Error(`host-allocations reads the frames of the windows of the application, and sok windows lists ${JSON.stringify(listed)}`);
  }
  const windows = listed.map(({ window }) => window);
  const replies = () => windows.map((window) => ({ ...reply(["status", "host.window", "--window", window]), window }));
  const settledBytes = await measure({
    pid, minutes,
    totals: (id) => heapTotals(execFileSync("heap", [String(id)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })),
    footprint: async (id) => (await readFootprint(id, async (command, args) => spawnSync(command, args, { encoding: "utf8" }))).bytes,
    readFrames: async () => windowFrames(replies()),
    wait: (ms) => sleep(ms),
    log: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  });
  if (b3Out !== null) writeB3Out(b3Out, b3Output({ settledBytes, windows: replies(), trace, policy: readPolicy(configDir).classes }));
}
