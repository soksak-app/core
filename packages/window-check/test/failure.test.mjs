import assert from "node:assert/strict";
import test from "node:test";

import { joinedFailure } from "../failure.mjs";

test("a failure of several errors names the message of each, because a test report shows only the message of the failure", () => {
  const first = new Error("the drag did not settle");
  const second = new Error("the capture did not stop");
  const failure = joinedFailure("independent settings and widths", [first, second, "a thrown text"]);
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.message, "independent settings and widths: the drag did not settle; the capture did not stop; a thrown text");
  assert.deepEqual(failure.errors, [first, second, "a thrown text"]);
  const nested = joinedFailure("the check and its cleanup failed", [failure, new Error("the window stayed open")]);
  assert.match(nested.message, /the capture did not stop; a thrown text; the window stayed open$/);
});
