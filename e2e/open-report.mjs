// 프로젝트 열기 검사가 늦은 응답의 단계와 그때의 시스템 상태를 보고하는 데 쓰는 함수.
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

/** 측정 때의 시스템 상태: 부하 평균과 CPU 사용이 큰 프로세스 다섯 개. 늦은 응답이 다른 프로세스의 부하 때문인지 가린다. */
export function systemState() {
  const ps = spawnSync("ps", ["-Ao", "pcpu,comm", "-r"], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed with ${ps.status}: ${ps.stderr}`);
  const top = ps.stdout.trim().split("\n").slice(1, 6).map((line) => line.trim()).join("; ");
  return `load average ${loadavg().map((value) => value.toFixed(1)).join(" ")} on ${availableParallelism()} processors; top CPU: ${top}`;
}
