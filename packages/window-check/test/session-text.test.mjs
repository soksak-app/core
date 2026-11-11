// The text step of a session sends input.text with the step, its text and its ranges, and unmark without a text
// (docs/spec/exposure.md#methods).
import assert from "node:assert/strict";
import test from "node:test";

import { Session } from "../app.mjs";

test("a session sends a step of a composition as input.text", () => {
  const sent = [];
  const session = { request: (method, params) => sent.push([method, params]) };
  Session.prototype.text.call(session, "mark", "한", { selection: { start: 0, length: 1 } });
  Session.prototype.text.call(session, "insert", "한글", { replacement: { start: 2, length: 1 } });
  Session.prototype.text.call(session, "unmark");
  assert.deepEqual(sent, [
    ["input.text", { phase: "mark", text: "한", selection: { start: 0, length: 1 } }],
    ["input.text", { phase: "insert", text: "한글", replacement: { start: 2, length: 1 } }],
    ["input.text", { phase: "unmark" }],
  ]);
});
