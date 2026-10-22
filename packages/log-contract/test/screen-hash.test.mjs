// The golden vectors of the screen hash (docs/spec/replay.md#screen-hash): the implementation that plugin pages use reproduces
// the canonical bytes and the hash of each screen, and refuses each screen the vectors list as rejected with its error text.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { screenBytes, screenHash } from "@soksak/plugin-api/screen-hash";

const fixture = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/log-contract/replay/screen-hash.json", import.meta.url), "utf8"));

const hex = (bytes) => Buffer.from(bytes).toString("hex");

for (const vector of fixture.vectors) {
  test(`the screen "${vector.name}" has the canonical bytes and the hash of the vector`, async () => {
    assert.equal(hex(screenBytes(vector.screen)), vector.bytes_hex);
    assert.equal(await screenHash(vector.screen), vector.hash);
  });
}

for (const vector of fixture.rejected) {
  test(`the screen "${vector.name}" is refused with the error of the vector`, async () => {
    assert.throws(() => screenBytes(vector.screen), { message: vector.error });
    await assert.rejects(screenHash(vector.screen), { message: vector.error });
  });
}

// The viewport, the selection and the theme enter the hash only through the drawn cells and the cursor (docs/spec/replay.md#view-state).
test("the vectors fix the drawn screen under a scrolled viewport, a selection and a theme", async () => {
  const byName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));
  const scrolled = byName.get("scrolled viewport with the cursor outside it");
  const selected = byName.get("selected cells with the highlight colors");
  const themed = byName.get("the same text under another theme");
  const plain = byName.get("ascii with hidden cursor");
  assert.ok(scrolled && selected && themed && plain, "the three view vectors exist");
  assert.equal(scrolled.screen.cursor.visible, false);
  assert.equal(scrolled.screen.cursor.row, 0);
  assert.equal(scrolled.screen.cursor.col, 2);
  assert.notEqual(selected.screen.cells[0].bg, null);
  assert.notEqual(themed.hash, selected.hash);
  assert.deepEqual(themed.screen.cells.map((cell) => cell.grapheme), selected.screen.cells.map((cell) => cell.grapheme));
});

test("two screens that differ in one cell have different hashes", async () => {
  const [one] = fixture.vectors;
  const other = structuredClone(one.screen);
  other.cells[0].attributes = 1;
  assert.notEqual(await screenHash(other), await screenHash(one.screen));
});
