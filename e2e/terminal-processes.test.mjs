import assert from "node:assert/strict";
import test from "node:test";
import { processRows } from "./terminal-processes.mjs";

test("process measurement preserves identities, state, and paths with spaces", () => {
  assert.deepEqual(processRows("  7  1 S /my path/service --service-dir /config path\n 9 7 Z /bin/sh\n"), [
    { pid: 7, parent: 1, state: "S", command: "/my path/service --service-dir /config path" },
    { pid: 9, parent: 7, state: "Z", command: "/bin/sh" },
  ]);
});

test("process measurement rejects malformed rows instead of dropping them", () => {
  assert.throws(() => processRows("not a process row"), /invalid process row/);
});
