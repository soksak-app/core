// The process table of the platform (docs/spec/verification.md#process-table): real processes that the test starts and ends.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { processes, workingDirectory } from "../platform/platform.mjs";

const WAIT = fileURLToPath(new URL("../fixtures/wait-stdin.mjs", import.meta.url));

test("the process table is read whole while other processes carry commands larger than a read buffer", { timeout: 20000 }, (t) => {
  // Three processes carry arguments of 450 KB each. The 450 KB are five arguments of 90 KB, because a single argument of a Linux
  // exec is limited to 128 KiB (MAX_ARG_STRLEN) and a longer one fails the spawn with E2BIG.
  const argument = "x".repeat(90 * 1024);
  const large = Array.from({ length: 3 }, () => spawn(process.execPath, [WAIT, ...Array(5).fill(argument)], { stdio: ["pipe", "ignore", "ignore"] }));
  t.after(() => { for (const child of large) child.kill("SIGKILL"); });
  const rows = processes({ command: true });
  for (const child of large) {
    const row = rows.find((entry) => entry.pid === child.pid);
    assert.equal(row?.command, [process.execPath, WAIT, ...Array(5).fill(argument)].join(" "), `the row of pid ${child.pid}`);
  }
  const own = rows.find((row) => row.pid === process.pid);
  assert.deepEqual([own.ppid, own.state], [process.ppid, "running"]);
});

test("a child that exited and was not reaped is a zombie of the group of its parent", { timeout: 20000 }, async () => {
  // The parent forks a child that exits at once, prints its pid and waits on its input without reaping it, so the child stays a
  // zombie until the parent ends. A shell reaps its background jobs, so the parent is perl, which reaps only through wait.
  const parent = spawn("perl", ["-e", "$| = 1; my $child = fork(); exit 0 if $child == 0; print \"$child\\n\"; <STDIN>;"],
    { stdio: ["pipe", "pipe", "inherit"], detached: true });
  const [data] = await once(parent.stdout, "data");
  const child = Number(String(data).trim());
  let row;
  // The child ends after the shell printed its pid, and no event tells this process when the child of another process ends, so the
  // test reads the table until the child is a zombie; it passes the states running and exiting on the way.
  for (;;) {
    row = processes().find((entry) => entry.pid === child);
    if (row === undefined || row.state === "zombie") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  parent.stdin.end();
  await once(parent, "exit");
  assert.deepEqual(row && [row.ppid, row.pgid, row.state], [parent.pid, parent.pid, "zombie"]);
});

test("the resident size, the CPU time, the executable and the working directory of this process are read", { timeout: 20000 }, () => {
  const own = processes({ residentKb: true, cpuSeconds: true, executable: true }).find((row) => row.pid === process.pid);
  assert.ok(own.residentKb > 1024, `resident ${own.residentKb} KB`);
  assert.ok(own.cpuSeconds > 0 && own.cpuSeconds < process.cpuUsage().user / 1e6 + process.cpuUsage().system / 1e6 + 1, `cpu ${own.cpuSeconds} s`);
  assert.equal(own.executable, process.execPath);
  assert.equal(workingDirectory(process.pid), process.cwd());
  const ended = spawnSync("/usr/bin/true");
  assert.equal(workingDirectory(ended.pid), null);
});
