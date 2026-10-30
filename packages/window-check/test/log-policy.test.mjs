// Checks the gate of the window-check log policy (docs/spec/logging.md#policy): a record that passes every gate is not checked
// against the policy, and a record that no catalog declares is an error.
import assert from "node:assert/strict";
import test from "node:test";
import { policyOfSetting, requireStored } from "../log-policy.mjs";

test("a check that reads the removed migration record is refused because the catalog does not declare it", () => {
  const policy = policyOfSetting({});
  assert.throws(() => requireStored(policy, { events: {} }, ["log.migrated"], "the default policy"),
    /the check reads log\.migrated, which the catalog does not declare/);
});
