// Checks the plugin literal check of view-check.js (F238-c-11): the view-start hash, the four VIEW_IMPORTS entries and one
// screen-message vector are compared with the SDK, and each difference is reported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkViewLiteral, VIEW_START_SHA256 } from "../view-check.js";

const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/spec/cases/log-contract/replay/screen-message.json", import.meta.url)), "utf8"));

// The literal a plugin writes: the values copied from the SDK, as a plugin would hold them.
function literal() {
  const vector = VECTORS.vectors[1];
  return {
    viewStartSha256: VIEW_START_SHA256,
    screenMessage: { name: vector.name, message: structuredClone(vector.message), hash: vector.hash },
  };
}

test("a literal copied from the SDK has no difference", () => {
  assert.deepEqual(checkViewLiteral(literal(), { vectors: VECTORS }), []);
});

test("a changed view-start.js fails until the constant and the literals are updated", () => {
  const other = "0".repeat(64);
  assert.deepEqual(checkViewLiteral(literal(), { scriptSha: other, vectors: VECTORS }), [
    `view-start.js is ${other}, the check holds ${VIEW_START_SHA256}; update the constant and every plugin literal`,
  ]);
});

test("a literal whose view-start hash differs from the SDK constant fails", () => {
  const plugin = literal();
  plugin.viewStartSha256 = "1".repeat(64);
  assert.deepEqual(checkViewLiteral(plugin, { vectors: VECTORS }), [
    `viewStartSha256 is ${JSON.stringify("1".repeat(64))}, want ${VIEW_START_SHA256}`,
  ]);
});

test("a literal that holds viewImports is reported, because the host inserts the view import map", () => {
  const plugin = literal();
  plugin.viewImports = { soksak: "sok://core/modules/soksak/dist/index.js" };
  assert.deepEqual(checkViewLiteral(plugin, { vectors: VECTORS }), [
    `viewImports is not part of the literal: the host inserts the view import map (docs/spec/plugin-processes.md, rule 4)`,
  ]);
});

test("a screen vector that differs from the core fixture is reported", () => {
  const plugin = literal();
  plugin.screenMessage.message.cursor.col = 0;
  plugin.screenMessage.hash = "2".repeat(64);
  assert.deepEqual(checkViewLiteral(plugin, { vectors: VECTORS }), [
    `screenMessage "ascii with hidden cursor": message differs from the core vector`,
    `screenMessage "ascii with hidden cursor": hash is ${JSON.stringify("2".repeat(64))}, want ${JSON.stringify(VECTORS.vectors[1].hash)}`,
  ]);
});

test("a screen vector whose name the core fixture does not hold is reported", () => {
  const plugin = literal();
  plugin.screenMessage.name = "not a vector";
  assert.deepEqual(checkViewLiteral(plugin, { vectors: VECTORS }), [`screenMessage names no vector of the core fixture: "not a vector"`]);
});
