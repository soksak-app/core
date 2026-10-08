// Checks the parameters of a tab when it opens and when a stored tab opens (docs/spec/plugins.md#pluginjson).
import assert from "node:assert/strict";
import test from "node:test";
import { checkTabParams, storedParamsProblem } from "../tab-params.js";

const declaration = { type: "object", properties: { path: { type: "string" } } };

test("a new tab keeps a copy of params that match the declaration", () => {
  const params = { path: "notes.md" };
  const kept = checkTabParams("probe", declaration, params);
  assert.deepEqual(kept, params);
  assert.notEqual(kept, params);
  assert.equal(checkTabParams("probe", declaration, undefined), null);
  assert.equal(checkTabParams("plain", null, undefined), null);
  assert.throws(() => checkTabParams("probe", declaration, { path: 3 }), /params do not match probe surface.params/);
  assert.throws(() => checkTabParams("plain", null, { path: "x" }), /plugin plain declares no tab params/);
});

test("a stored tab whose params do not match its plugin states the reason for its placeholder", () => {
  assert.equal(storedParamsProblem("probe", "0.0.1", declaration, { path: "notes.md" }), null);
  assert.equal(storedParamsProblem("probe", "0.0.1", declaration, undefined), null);
  assert.equal(storedParamsProblem("probe", "0.0.2", declaration, { path: 3 }),
    "probe 0.0.2 탭의 인자가 선언과 맞지 않습니다: params do not match probe surface.params");
  assert.equal(storedParamsProblem("plain", "0.0.6", null, { path: "x" }),
    "plain 0.0.6 탭의 인자가 선언과 맞지 않습니다: plugin plain declares no tab params");
});
