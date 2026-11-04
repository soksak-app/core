// Measures the allocations of the host process of a running application at start and after each minute.
//
// The host is the one application process whose command line has --config-dir DIR, found as `make app-usage` finds it
// (hostProcess of scripts/measure-app-usage.mjs), so the measurement names the application and not a process id. Before the
// first reading it sets the trace state of TRACE through the sok of the application (scripts/measure-trace.mjs). The
// allocations are the live nodes and bytes of every malloc zone that `heap` reports for the process ("All zones: N nodes
// (B bytes)"). The interval waits for no event, so it is set by duration. Each step prints {phase, elapsedMs, pid, nodes,
// bytes} as one JSON line and makes no judgment. `make host-allocations` runs it.
//
//   node scripts/measure-host-allocations.mjs --sok PATH --config-dir DIR --trace 0|1 [--minutes N]
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hostProcess, parseProcessTable } from "./measure-app-usage.mjs";
import { applyTrace, parseTrace } from "./measure-trace.mjs";

/** The live nodes and bytes of all zones in the output of `heap`; output without the totals line is an error that quotes its start. */
export function heapTotals(text) {
  const match = /^All zones: (\d+) nodes \((\d+) bytes\)$/m.exec(text);
  if (match === null) throw new Error(`heap printed no line "All zones: N nodes (B bytes)": ${text.slice(0, 200)}`);
  return { nodes: Number(match[1]), bytes: Number(match[2]) };
}

/** Records the totals at start and after each of `minutes` intervals. */
export async function measure({ pid, minutes, totals, wait, log, now = Date.now }) {
  const started = now();
  log({ phase: "start", elapsedMs: 0, pid, ...totals(pid) });
  for (let minute = 1; minute <= minutes; minute++) {
    await wait(60_000);
    log({ phase: `minute ${minute}`, elapsedMs: now() - started, pid, ...totals(pid) });
  }
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
    options: { sok: { type: "string" }, "config-dir": { type: "string" }, trace: { type: "string" }, minutes: { type: "string", default: "10" } },
  });
  const trace = parseTrace(values.trace);
  if (!values.sok || !values["config-dir"]) throw new Error("required options: --sok PATH --config-dir DIR");
  const minutes = Number(values.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error(`--minutes must be a positive integer, got ${values.minutes}`);
  return { sok: values.sok, configDir: values["config-dir"], trace, minutes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sok, configDir, trace, minutes } = parseOptions(process.argv.slice(2));
  const pid = await prepare({
    processes: parseProcessTable(execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" })),
    configDir, realPath: realpathSync(configDir), trace,
    run: async (command, params) => JSON.parse(execFileSync(sok, [command, "--params", JSON.stringify(params), "--config-dir", configDir], { encoding: "utf8" })),
  });
  await measure({
    pid, minutes,
    totals: (id) => heapTotals(execFileSync("heap", [String(id)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })),
    wait: (ms) => sleep(ms),
    log: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  });
}
