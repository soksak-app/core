// The member role of the stored tabs: a tab without a role stores null, and a stored record is kept as it is
// (docs/spec/agent-roles.md#tab-role-state).
import assert from "node:assert/strict";
import test from "node:test";
import { recordOrigin, storedLayoutState } from "../tab-reports.js";

const record = { id: "reviewer", generation: 2, fingerprint: "0123456789abcdef", confirmedFingerprint: null };

test("a tab without a role stores the member role as null", () => {
  recordOrigin("role-none", null, "test fixture");
  const stored = storedLayoutState({ root: { card: "c", data: { tabs: [{ id: "role-none", plugin: "p" }] } } });
  assert.deepEqual(stored.root.data.tabs[0].role, null);
});

test("a stored tab role record is kept verbatim", () => {
  recordOrigin("role-record", null, "test fixture");
  const stored = storedLayoutState({ root: { card: "c", data: { tabs: [{ id: "role-record", plugin: "p", role: record }] } } });
  assert.deepEqual(stored.root.data.tabs[0].role, record);
});
