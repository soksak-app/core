// 프로젝트 열기 검사가 늦은 응답의 단계와 그때의 시스템 상태를 보고하는 데 쓰는 함수.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

/** 성능 기록 파일의 현재 길이. 이 위치 뒤에 쓰인 줄이 이후 동작의 기록이다. */
export const traceLength = (file) => (existsSync(file) ? readFileSync(file, "utf8").length : 0);

/**
 * 성능 기록에서 offset 뒤 페이지 배치 단계와 명령 결과를 처음 줄 기준 경과 ms 로 적는다. 프로젝트 열기가 늦을 때 어느
 * 단계가 시간을 썼는지 보고한다.
 */
export function openStages(file, offset) {
  const rows = readFileSync(file, "utf8").slice(offset).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.layer === "page" && ["action", "layout", "command"].includes(row.event));
  if (!rows.length) return "no page trace rows";
  const start = Date.parse(rows[0].ts);
  return rows.map((row) => `${row.event === "layout" ? `layout ${row.id} ${row.phase}` : `${row.event} ${row.kind ?? row.name}`}` +
    `@${Date.parse(row.ts) - start}ms`).join(", ");
}

/** 측정 때의 시스템 상태: 부하 평균과 CPU 사용이 큰 프로세스 다섯 개. 늦은 응답이 다른 프로세스의 부하 때문인지 가린다. */
export function systemState() {
  const ps = spawnSync("ps", ["-Ao", "pcpu,comm", "-r"], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed with ${ps.status}: ${ps.stderr}`);
  const top = ps.stdout.trim().split("\n").slice(1, 6).map((line) => line.trim()).join("; ");
  return `load average ${loadavg().map((value) => value.toFixed(1)).join(" ")} on ${availableParallelism()} processors; top CPU: ${top}`;
}
