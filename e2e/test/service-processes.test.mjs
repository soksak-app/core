import assert from "node:assert/strict";
import test from "node:test";
import { processRows, rowsRunningFrom } from "../service-processes.mjs";

test("the process rows hold this process with its parent, state and command", () => {
  const own = processRows().find((row) => row.pid === process.pid);
  assert.deepEqual({ parent: own.parent, state: own.state }, { parent: process.ppid, state: "running" });
  assert.ok(own.command.startsWith(process.argv0), own.command);
});

test("the processes that run from a folder are those whose executable lies inside it, without zombies", () => {
  const rows = [
    { pid: 7, parent: 1, state: "running", command: "/copy/probe/0.0.41/bin/probe --service-dir /config/services/probe" },
    { pid: 8, parent: 7, state: "running", command: "/copy/probe/0.0.41/bin/probe --session s1" },
    { pid: 9, parent: 7, state: "zombie", command: "/copy/probe/0.0.41/bin/probe" },
    { pid: 10, parent: 1, state: "running", command: "/copy/probe/0.0.40/bin/probe --service-dir /config/services/probe" },
    { pid: 11, parent: 1, state: "running", command: "/copy/probe/0.0.410/bin/probe" },
    { pid: 12, parent: 1, state: "running", command: "/bin/sh -c /copy/probe/0.0.41/bin/probe" },
  ];
  assert.deepEqual(rowsRunningFrom(rows, ["/copy/probe/0.0.41"]).map((row) => row.pid), [7, 8]);
  assert.deepEqual(rowsRunningFrom(rows, ["/elsewhere", "/copy/probe/0.0.40"]).map((row) => row.pid), [10]);
});
