// The screen hash helper of plugin pages (docs/spec/replay.md#screen-hash): the canonical bytes of a screen and their SHA-256.

import assert from "node:assert/strict";
import test from "node:test";
import { screenBytes, screenFromMessage, screenHash } from "../screen-hash.js";

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

// The screen message of a sidecar (docs/spec/persistent-services.md#screen-message).
const message = () => ({
  event: "screen",
  sequence: 4,
  segment: "b1",
  rows: 1,
  cols: 2,
  cursor: { row: 0, col: 1, visible: true, shape: "block", focused: true },
  cells: [{ grapheme: "a", width: 1, fg: 3, bg: null, attributes: 1, link: "https://example.test/" }, { grapheme: "", width: 1, fg: null, bg: "#000000", attributes: 0 }],
});

test("a screen message gives the screen that the hash takes, without the members that the hash does not cover", async () => {
  const screen = screenFromMessage(message());
  assert.deepEqual(screen, {
    rows: 1,
    cols: 2,
    cursor: { row: 0, col: 1, visible: true },
    cells: [{ grapheme: "a", width: 1, fg: 3, bg: null, attributes: 1 }, { grapheme: "", width: 1, fg: null, bg: "#000000", attributes: 0 }],
  });
  assert.match(await screenHash(screen), /^[0-9a-f]{64}$/);
});

test("a screen message without a sequence is refused with the member named", () => {
  const without = message();
  delete without.sequence;
  assert.throws(() => screenFromMessage(without), { message: "screen message: sequence must be an integer from 1, found undefined" });
});

test("a screen message without a segment is refused with the member named", () => {
  const without = message();
  delete without.segment;
  assert.throws(() => screenFromMessage(without), { message: "screen message: segment must be a non-empty string, found undefined" });
});

test("a screen message with a cell that has no resolved foreground is refused with the cell named", () => {
  const without = message();
  delete without.cells[0].fg;
  assert.throws(() => screenFromMessage(without), { message: 'screen message: cells[0].fg must be a resolved color (null, an integer from 0 to 255 or "#rrggbb"), found undefined' });
});

test("a message that is not an object is refused", () => {
  assert.throws(() => screenFromMessage(null), { message: "screen message: message must be an object, found null" });
});
