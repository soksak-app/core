// The golden vectors of the screen hash (docs/spec/replay.md#screen-hash): the implementation that plugin pages use reproduces
// the canonical bytes and the hash of each screen, and refuses each screen the vectors list as rejected with its error text.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { screenBytes, screenHash } from "@soksak/plugin-api/screen-hash";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/replay/screen-hash.json", import.meta.url), "utf8"));

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

test("two screens that differ in one cell have different hashes", async () => {
  const [one] = fixture.vectors;
  const other = structuredClone(one.screen);
  other.cells[0].attributes = 1;
  assert.notEqual(await screenHash(other), await screenHash(one.screen));
});
