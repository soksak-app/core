// Measures the allocations of a running host process at start and after each minute.
//
// The allocations are the live nodes and bytes of every malloc zone that `heap` reports for the process ("All zones: N nodes
// (B bytes)"). The interval waits for no event, so it is set by duration. Each step prints {phase, elapsedMs, pid, nodes,
// bytes} as one JSON line and makes no judgment. `make host-allocations` runs it.
//
//   node scripts/measure-host-allocations.mjs --pid PID [--minutes N]
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const pid = Number(value("--pid"));
  const minutes = Number(value("--minutes") ?? 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`--pid must be a process id, got ${value("--pid")}`);
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error(`--minutes must be a positive integer, got ${value("--minutes")}`);
  await measure({
    pid, minutes,
    totals: (id) => heapTotals(execFileSync("heap", [String(id)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })),
    wait: (ms) => sleep(ms),
    log: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
  });
}
