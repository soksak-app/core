// Tests of scripts/check-process-tools.mjs: a Go, Rust or Node source that starts ps, kill, pgrep or lsof as a subprocess is a
// finding.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { processToolFindings } from "../check-process-tools.mjs";

// The tool names are joined from parts: the check scans this file's repository, and the literals below are its inputs.
const quoted = (name, mark = '"') => `${mark}${name}${mark}`;

test("a Go source that starts a process tool is a finding with its line", { timeout: 1000 }, () => {
  const source = [
    "package x",
    `out, _ := exec.Command(${quoted("ps")}, "-o", "rss=").Output()`,
    `_ = exec.CommandContext(ctx, ${quoted("kill")}, "-9", pid).Run()`,
    `_ = exec.Command(${quoted("/usr/sbin/lsof")}, "-p", pid).Run()`,
    `_ = exec.Command("cat").Run()`,
  ].join("\n");
  assert.deepEqual(processToolFindings("packages/x/a.go", source), [
    "packages/x/a.go:2: starts ps as a subprocess",
    "packages/x/a.go:3: starts kill as a subprocess",
    "packages/x/a.go:4: starts lsof as a subprocess",
  ]);
});

test("a Rust source that starts a process tool is a finding, also across lines", { timeout: 1000 }, () => {
  const source = [
    `let lstart = std::process::Command::new(${quoted("ps")})`,
    "    .output();",
    `Command::new(${quoted("pgrep")}).arg("-P");`,
    `let _ = Command::new(\n    ${quoted("/bin/kill")},\n);`,
    `Command::new("/bin/sleep");`,
  ].join("\n");
  assert.deepEqual(processToolFindings("packages/x/a.rs", source), [
    "packages/x/a.rs:1: starts ps as a subprocess",
    "packages/x/a.rs:3: starts pgrep as a subprocess",
    "packages/x/a.rs:4: starts kill as a subprocess",
  ]);
});

test("a Node source that starts a process tool is a finding, by any quote and also across lines", { timeout: 1000 }, () => {
  const source = [
    `const ps = spawnSync(${quoted("ps", "'")}, ["-o", "stat="]);`,
    `execFileSync(${quoted("pgrep")}, ["-P", pid]);`,
    `await execFile(\n  ${quoted("/usr/sbin/lsof", "`")}, args);`,
    `spawn(${quoted("kill")}, ["-9", pid]);`,
    `execSync(${quoted("ps -axo pid=")});`,
    `spawn("/bin/sleep", ["1"]); process.kill(pid, "SIGKILL"); send("kill", record);`,
  ].join("\n");
  assert.deepEqual(processToolFindings("scripts/a.mjs", source), [
    "scripts/a.mjs:1: starts ps as a subprocess",
    "scripts/a.mjs:2: starts pgrep as a subprocess",
    "scripts/a.mjs:3: starts lsof as a subprocess",
    "scripts/a.mjs:5: starts kill as a subprocess",
    "scripts/a.mjs:6: starts ps as a subprocess",
  ]);
});

test("the sources of the repository start no process tool", { timeout: 60_000 }, () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const run = spawnSync(process.execPath, ["scripts/check-process-tools.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /^Process tool check passed: \d+ Go, Rust and Node sources\n$/);
});
