import assert from "node:assert/strict";
import test from "node:test";
import { docViolations } from "@soksak/kit/docs";

test("the pinned record validator preserves runtime diagnostics and rejects discovery accounts", { timeout: 30000 }, () => {
  const record = "The native callback failed with `invalid pointer found on stack` during a stack copy.";
  assert.deepEqual(docViolations(record, "docs/features.md"), []);
  for (const account of ["Found on 2026-11-07 during a build.", "- Found on the release build.", "The defect was found on the release build."]) {
    assert.ok(docViolations(account, "docs/features.md").some((error) => error.includes("account of who found or requested")), account);
  }
});
