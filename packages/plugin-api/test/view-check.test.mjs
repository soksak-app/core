// Checks the plugin literal check of view-check.js (F238-c-11): the view-start hash, the four VIEW_IMPORTS entries and one
// screen-message vector are compared with the SDK, and each difference is reported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VIEW_IMPORTS } from "../index.js";
import { checkViewLiteral, VIEW_START_SHA256 } from "../view-check.js";

const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL("../../log-contract/fixtures/replay/screen-message.json", import.meta.url)), "utf8"));

// The literal a plugin writes: the values copied from the SDK, as a plugin would hold them.
function literal() {
  const vector = VECTORS.vectors[1];
  return {
    viewStartSha256: VIEW_START_SHA256,
    viewImports: { ...VIEW_IMPORTS },
    screenMessage: { name: vector.name, message: structuredClone(vector.message), hash: vector.hash },
  };
}

test("a literal copied from the SDK has no difference", () => {
  assert.deepEqual(checkViewLiteral(literal()), []);
});

test("a changed view-start.js fails until the constant and the literals are updated", () => {
  const other = "0".repeat(64);
  assert.deepEqual(checkViewLiteral(literal(), { scriptSha: other }), [
    `view-start.js is ${other}, the check holds ${VIEW_START_SHA256}; update the constant and every plugin literal`,
  ]);
});

test("a literal whose view-start hash differs from the SDK constant fails", () => {
  const plugin = literal();
  plugin.viewStartSha256 = "1".repeat(64);
  assert.deepEqual(checkViewLiteral(plugin), [
    `viewStartSha256 is ${JSON.stringify("1".repeat(64))}, want ${VIEW_START_SHA256}`,
  ]);
});

test("a changed VIEW_IMPORTS entry and an extra entry are each reported", () => {
  const plugin = literal();
  plugin.viewImports["@soksak/shared/"] = "sok://elsewhere/shared/";
  plugin.viewImports["@soksak/runtime"] = "sok://core/runtime.js";
  assert.deepEqual(checkViewLiteral(plugin), [
    `viewImports "@soksak/shared/" is "sok://elsewhere/shared/", want "sok://core/shared/"`,
    `viewImports has unexpected entry "@soksak/runtime"`,
  ]);
});

test("a screen vector that differs from the core fixture is reported", () => {
  const plugin = literal();
  plugin.screenMessage.message.cursor.col = 0;
  plugin.screenMessage.hash = "2".repeat(64);
  assert.deepEqual(checkViewLiteral(plugin), [
    `screenMessage "ascii with hidden cursor": message differs from the core vector`,
    `screenMessage "ascii with hidden cursor": hash is ${JSON.stringify("2".repeat(64))}, want ${JSON.stringify(VECTORS.vectors[1].hash)}`,
  ]);
});

test("a screen vector whose name the core fixture does not hold is reported", () => {
  const plugin = literal();
  plugin.screenMessage.name = "not a vector";
  assert.deepEqual(checkViewLiteral(plugin), [`screenMessage names no vector of the core fixture: "not a vector"`]);
});
