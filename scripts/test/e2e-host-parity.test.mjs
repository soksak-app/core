import assert from "node:assert/strict";
import test from "node:test";
import { auditE2EHostParity } from "../check-e2e-host-parity.mjs";

test("every application E2E suite runs the same scenario through both adapters", () => {
  const result = auditE2EHostParity();
  assert.deepEqual(result.errors, []);
  assert.ok(result.shared.length >= 14, `expected the current shared suite inventory, got ${result.shared.length}`);
  assert.deepEqual(result.unitOnly.map(({ file }) => file), [
    "app-contract.test.mjs",
    "composition-measurement.test.mjs",
    "terminal-processes.test.mjs",
  ]);
});
