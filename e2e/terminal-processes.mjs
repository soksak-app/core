// 검사 설정에 속한 서비스와 자식만 센다. 다른 실행 중인 앱의 세션은 건드리지 않는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function processRows(text) {
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    assert.ok(match, `invalid process row: ${line}`);
    return { pid: Number(match[1]), parent: Number(match[2]), state: match[3], command: match[4] };
  });
}

export function terminalProcessSnapshot(configDir) {
  const serviceDir = join(realpathSync(configDir), "services", "soksak-vt-alacritty");
  const endpoint = JSON.parse(readFileSync(join(serviceDir, "endpoint.json"), "utf8"));
  assert.equal(endpoint.protocol, 1, "terminal service protocol does not match");
  assert.ok(Number.isInteger(endpoint.pid) && endpoint.pid > 0, "terminal service PID is missing");
  const rows = processRows(execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" }));
  const services = rows.filter((row) => row.command.endsWith(`--service-dir ${serviceDir}`));
  assert.equal(services.length, 1, "the configuration must own exactly one terminal service");
  assert.equal(services[0].pid, endpoint.pid, "published service PID differs from the running process");
  assert.equal(services[0].state.includes("Z"), false, "terminal service is a zombie");
  const shells = rows.filter((row) => row.parent === endpoint.pid);
  for (const shell of shells) {
    assert.equal(shell.state.includes("Z"), false, `terminal child ${shell.pid} is a zombie`);
    assert.doesNotMatch(shell.command, /soksak-ptyd/, "terminal service must not start a PTY helper process");
  }
  return { service: endpoint.pid, shells: shells.map(({ pid }) => pid).sort((a, b) => a - b) };
}
