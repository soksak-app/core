// Functions that the project opening checks use to report the stage of a late reply and the system state at that time.
import { spawnSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";

/**
 * The page rows of the trace (earlier lines of the stages of the page) with their elapsed time from the first row: the layout
 * queue phases, the actions and the command results. It reports which stage used the time when a project opens late.
 */
export function openStages(rows) {
  const stages = rows.filter((row) => row.layer === "page" && ["action", "layout", "command"].includes(row.event));
  if (!stages.length) return "no page trace rows";
  const start = Date.parse(stages[0].ts);
  return stages.map((row) => `${row.event === "layout" ? `layout ${row.id} ${row.phase}` : `${row.event} ${row.kind ?? row.name}`}` +
    `@${Date.parse(row.ts) - start}ms`).join(", ");
}

/** The system state at the measurement: the load average and the five processes with the highest CPU use. It separates whether a late reply is caused by the load of other processes. */
export function systemState() {
  const ps = spawnSync("ps", ["-Ao", "pcpu,comm", "-r"], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed with ${ps.status}: ${ps.stderr}`);
  const top = ps.stdout.trim().split("\n").slice(1, 6).map((line) => line.trim()).join("; ");
  return `load average ${loadavg().map((value) => value.toFixed(1)).join(" ")} on ${availableParallelism()} processors; top CPU: ${top}`;
}
