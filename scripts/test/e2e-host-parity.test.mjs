import assert from "node:assert/strict";
import test from "node:test";
import { auditE2EHostParity } from "../check-e2e-host-parity.mjs";

test("every application E2E suite runs the same scenario through both adapters", () => {
  const result = auditE2EHostParity();
  assert.deepEqual(result.errors, []);
  assert.ok(result.shared.length >= 14, `expected the current shared suite inventory, got ${result.shared.length}`);
});

// The unit tests of the window-check helpers are in e2e/test/ (docs/operations/examples.md#test-kinds), so every test file of
// the window-check folder is an application suite and no file name is exempt.
test("a window-check file that does not run both adapters is an error whatever its name", () => {
  const result = auditE2EHostParity(["app-contract.test.mjs"], () => 'import test from "node:test";\n');
  assert.deepEqual(result.errors, ["app-contract.test.mjs: app behavior test does not import APPS"]);
});
