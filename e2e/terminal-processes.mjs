// Counts only the services and children that belong to the check configuration. Sessions of other running apps are not touched.
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
  // The host passes the service folder and the log folder (docs/spec/sidecars.md#declaration-and-startup), so the argument
  // is matched as one argument of the command, wherever it stands.
  const services = rows.filter((row) => ` ${row.command} `.includes(` --service-dir ${serviceDir} `));
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
