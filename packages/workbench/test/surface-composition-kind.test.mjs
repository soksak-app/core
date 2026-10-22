import assert from "node:assert/strict";
import test from "node:test";
import { compositionKindOf } from "../surface-composition-kind.js";

test("core.surfaces reports the composition kind of a surface declaration", () => {
  assert.equal(compositionKindOf({ composition: { kind: "view", page: "ui/page.html" } }), "view");
  assert.equal(compositionKindOf({ composition: { kind: "dom" } }), "dom");
});

test("a surface without a declaration reports no composition kind", () => {
  assert.equal(compositionKindOf(null), null);
});
