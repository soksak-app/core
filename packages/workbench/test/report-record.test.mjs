// The record that the page sends through the host call `report` (docs/spec/diagnostics.md#forms).
import assert from "node:assert/strict";
import test from "node:test";

import { recordOf } from "../report-record.js";

test("a line `<where>: <text>` is split at its first `: `", () => {
  assert.deepEqual(recordOf("error", "library: registry failed: unreachable"), {
    level: "error", where: "library", text: "registry failed: unreachable",
  });
});

test("a line without `: ` has the place page and is the whole text", () => {
  assert.deepEqual(recordOf("info", "focus in browser.address"), { level: "info", where: "page", text: "focus in browser.address" });
});

test("a line that starts with `: ` or holds a line feed before the separator keeps the place page", () => {
  assert.deepEqual(recordOf("error", ": nothing"), { level: "error", where: "page", text: ": nothing" });
  assert.deepEqual(recordOf("error", "first\nsecond: third"), { level: "error", where: "page", text: "first\nsecond: third" });
});

test("a value that is not text is written as its text and split like a line", () => {
  assert.deepEqual(recordOf("error", new Error("boom")), { level: "error", where: "Error", text: "boom" });
  assert.deepEqual(recordOf("error", 42), { level: "error", where: "page", text: "42" });
});
