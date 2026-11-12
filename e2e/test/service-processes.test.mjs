import assert from "node:assert/strict";
import test from "node:test";
import { processRows, rowsRunningFrom } from "../service-processes.mjs";

test("process measurement preserves identities, state, and paths with spaces", () => {
  assert.deepEqual(processRows("  7  1 S /my path/service --service-dir /config path\n 9 7 Z /bin/sh\n"), [
    { pid: 7, parent: 1, state: "S", command: "/my path/service --service-dir /config path" },
    { pid: 9, parent: 7, state: "Z", command: "/bin/sh" },
  ]);
});

test("process measurement rejects malformed rows instead of dropping them", () => {
  assert.throws(() => processRows("not a process row"), /invalid process row/);
});

test("the processes that run from a folder are those whose executable lies inside it, without zombies", () => {
  const rows = processRows([
    " 7 1 S /copy/probe/0.0.41/bin/probe --service-dir /config/services/probe",
    " 8 7 S /copy/probe/0.0.41/bin/probe --session s1",
    " 9 7 Z /copy/probe/0.0.41/bin/probe",
    " 10 1 S /copy/probe/0.0.40/bin/probe --service-dir /config/services/probe",
    " 11 1 S /copy/probe/0.0.410/bin/probe",
    " 12 1 S /bin/sh -c /copy/probe/0.0.41/bin/probe",
  ].join("\n"));
  assert.deepEqual(rowsRunningFrom(rows, ["/copy/probe/0.0.41"]).map((row) => row.pid), [7, 8]);
  assert.deepEqual(rowsRunningFrom(rows, ["/elsewhere", "/copy/probe/0.0.40"]).map((row) => row.pid), [10]);
});
