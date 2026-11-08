// Functions that the project opening checks use to report the stage of a late reply and the system state at that time.
import { spawnSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";

/**
 * The workbench rows of the trace (earlier lines of the stages of the workbench) with their elapsed time from the first row: the layout
 * queue phases, the actions and the command results. It reports which stage used the time when a project opens late.
 */
export function openStages(rows) {
  const stages = rows.filter((row) => row.layer === "workbench" && ["action", "layout", "command"].includes(row.event));
  if (!stages.length) return "no workbench trace rows";
  const start = Date.parse(stages[0].ts);
  return stages.map((row) => `${row.event === "layout" ? `layout ${row.id} ${row.phase}` : `${row.event} ${row.kind ?? row.name}`}` +
    `@${Date.parse(row.ts) - start}ms`).join(", ");
}

/** The system state at the measurement: the load average and the five processes with the highest CPU use. It separates whether a late reply is caused by the load of other processes. */
export function systemState() {
  // `ps -A -o pcpu=,comm=` is the POSIX form; the CPU order is made here, because the sort option of ps differs between systems.
  const ps = spawnSync("ps", ["-A", "-o", "pcpu=,comm="], { encoding: "utf8", maxBuffer: Infinity });
  if (ps.status !== 0) throw new Error(`ps failed with ${ps.status}: ${ps.stderr}`);
  const top = ps.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "")
    .map((line) => ({ line, cpu: Number.parseFloat(line) })).sort((a, b) => b.cpu - a.cpu)
    .slice(0, 5).map(({ line }) => line).join("; ");
  return `load average ${loadavg().map((value) => value.toFixed(1)).join(" ")} on ${availableParallelism()} processors; top CPU: ${top}`;
}
