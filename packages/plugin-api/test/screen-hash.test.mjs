// The screen hash helper of plugin pages (docs/spec/replay.md#screen-hash): the canonical bytes of a screen and their SHA-256.

import assert from "node:assert/strict";
import test from "node:test";
import { screenBytes, screenHash } from "../screen-hash.js";

const cell = (grapheme = "", width = 1, fg = null, bg = null, attributes = 0) => ({ grapheme, width, fg, bg, attributes });
const screen = (cells, cursor = { row: 0, col: 0, visible: true }, rows = 1, cols = cells.length) => ({ rows, cols, cursor, cells });

test("the bytes of a screen are the magic, the size, the cursor and the cells in row-major order", () => {
  const bytes = screenBytes(screen([cell("a", 1, 7, "#010203", 5)], { row: 0, col: 0, visible: false }));
  const expected = Buffer.concat([
    Buffer.from("SKSCR1"),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 1, 0x61, 1, 1, 0, 0, 7, 2, 1, 2, 3, 5]),
  ]);
  assert.equal(Buffer.from(bytes).toString("hex"), expected.toString("hex"));
});

test("the hash is 64 lowercase hexadecimal characters", async () => {
  assert.match(await screenHash(screen([cell("a")])), /^[0-9a-f]{64}$/);
});

test("a screen that is not an object is refused", () => {
  assert.throws(() => screenBytes(null), { message: "screen hash: screen must be an object, found null" });
});

test("a size that is not a positive integer is refused", () => {
  assert.throws(() => screenBytes({ ...screen([cell()]), rows: 0 }), { message: "screen hash: rows must be a positive integer, found 0" });
});
