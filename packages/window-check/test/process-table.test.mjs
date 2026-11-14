import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { processTable } from "../process-table.mjs";

test("the process table is read whole while other processes carry commands larger than a read buffer", { timeout: 20000 }, (t) => {
  // Three processes carry arguments of 450 KB each, so the commands of all processes exceed the 1 MiB output buffer of execFileSync.
  // Each process waits on its open standard input until the cleanup ends it. The 450 KB are five arguments of 90 KB, because a single
  // argument of a Linux exec is limited to 128 KiB (MAX_ARG_STRLEN) and a longer one fails the spawn with E2BIG.
  const large = Array.from({ length: 3 }, () => spawn(process.execPath, [fileURLToPath(new URL("../fixtures/wait-stdin.mjs", import.meta.url)), ...Array(5).fill("x".repeat(90 * 1024))], { stdio: ["pipe", "ignore", "ignore"] }));
  t.after(() => { for (const child of large) child.kill("SIGKILL"); });
  const rows = processTable("pid=,command=").split("\n");
  for (const child of large) {
    assert.ok(rows.some((row) => row.trim().startsWith(`${child.pid} `)), `the table has no row of pid ${child.pid}`);
  }
  assert.ok(rows.some((row) => row.trim().startsWith(`${process.pid} `)), `the table has no row of the test process ${process.pid}`);
});
