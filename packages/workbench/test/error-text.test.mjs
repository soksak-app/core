import assert from "node:assert/strict";
import test from "node:test";

import { errorText } from "../error-text.js";

test("a rejection keeps its message, code, and data without converting objects to a generic string", () => {
  assert.equal(errorText(new Error("refused")), "refused");
  assert.equal(errorText("plain text"), "plain text");
  assert.equal(errorText({ code: -32000, message: "refused", data: { path: "a" } }), 'refused (code -32000, data {"path":"a"})');
  assert.equal(errorText({ code: -32000, message: "refused" }), "refused (code -32000)");
  assert.equal(errorText({ code: 7 }), '{"code":7}');
});
