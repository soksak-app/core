import assert from "node:assert/strict";
import test from "node:test";

import { runningMembers } from "../process-group.mjs";

test("does not count a member that is exiting as running", () => {
  // ps(1) marks a process that is trying to exit with the flag E in its state. The measured state of F292-58 was ?NE, which the zombie check
  // (a state that starts with Z) did not recognize, so the exiting member counted as running and failed a passing test.
  assert.deepEqual(runningMembers(10, [{ pid: 11, state: "?NE" }, { pid: 12, state: "SE" }, { pid: 13, state: "Z" }]), []);
  assert.deepEqual(runningMembers(10, [{ pid: 14, state: "S" }, { pid: 15, state: "SE" }]), [{ pid: 14, state: "S" }]);
});
