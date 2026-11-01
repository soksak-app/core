// The screen hash helper of plugin pages (docs/spec/replay.md#screen-hash): the canonical bytes of a screen and their SHA-256.

import assert from "node:assert/strict";
import test from "node:test";
import { applyScreenMessage, screenBytes, screenHash } from "../screen-hash.js";

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
  number: 1,
  base: true,
  rows: 1,
  cols: 2,
  cursor: { row: 0, col: 1, visible: true, shape: "block", focused: true },
  cells: [{ grapheme: "a", width: 1, fg: 3, bg: null, attributes: 1, link: "https://example.test/" }, { grapheme: "", width: 1, fg: null, bg: "#000000", attributes: 0 }],
});

test("a screen message gives the screen that the hash takes, without the members that the hash does not cover", async () => {
  const screen = applyScreenMessage(null, message()).screen;
  assert.deepEqual(screen, {
    rows: 1,
    cols: 2,
    cursor: { row: 0, col: 1, visible: true },
    cells: [{ grapheme: "a", width: 1, fg: 3, bg: null, attributes: 1 }, { grapheme: "", width: 1, fg: null, bg: "#000000", attributes: 0 }],
  });
  assert.match(await screenHash(screen), /^[0-9a-f]{64}$/);
});

test("screen projection excludes a presentation caret but hashes the engine cursor", async () => {
  const first = message();
  first.cursor.caret = { row: 0, col: 0 };
  const movedPresentationCaret = message();
  movedPresentationCaret.cursor.caret = { row: 0, col: 1 };
  const absentPresentationCaret = message();
  absentPresentationCaret.cursor.caret = null;
  const firstScreen = applyScreenMessage(null, first).screen;
  const movedScreen = applyScreenMessage(null, movedPresentationCaret).screen;
  const absentScreen = applyScreenMessage(null, absentPresentationCaret).screen;

  assert.deepEqual(firstScreen, movedScreen, "the projection retained the provider presentation caret");
  assert.equal(await screenHash(firstScreen), await screenHash(movedScreen),
    "moving the presentation caret changed the committed-grid hash");
  assert.deepEqual(firstScreen, absentScreen, "the projection retained a null presentation caret");
  assert.equal(await screenHash(firstScreen), await screenHash(absentScreen),
    "a null presentation caret changed the committed-grid hash");

  const movedEngineCursor = message();
  movedEngineCursor.cursor.caret = { row: 0, col: 0 };
  movedEngineCursor.cursor.col = 0;
  assert.notEqual(await screenHash(firstScreen), await screenHash(applyScreenMessage(null, movedEngineCursor).screen),
    "changing the raw engine cursor did not change the screen hash");
});

test("a screen message without a sequence is refused with the member named", () => {
  const without = message();
  delete without.sequence;
  assert.throws(() => applyScreenMessage(null, without).screen, { message: "screen message: sequence must be an integer from 1, found undefined" });
});

test("a screen message without a segment is refused with the member named", () => {
  const without = message();
  delete without.segment;
  assert.throws(() => applyScreenMessage(null, without).screen, { message: "screen message: segment must be a non-empty string, found undefined" });
});

test("a screen message with a cell that has no resolved foreground is refused with the cell named", () => {
  const without = message();
  delete without.cells[0].fg;
  assert.throws(() => applyScreenMessage(null, without).screen, { message: 'screen message: cells[0].fg must be a resolved color (null, an integer from 0 to 255 or "#rrggbb"), found undefined' });
});

test("a message that is not an object is refused", () => {
  assert.throws(() => applyScreenMessage(null, null).screen, { message: "screen message: message must be an object, found null" });
});

// The change form of a screen message carries only the rows that changed since the message that it names
// (docs/spec/persistent-services.md#screen-message).
const grid = () => ({
  event: "screen", sequence: 7, segment: "b1", number: 3, base: true, rows: 2, cols: 2,
  cursor: { row: 0, col: 0, visible: true },
  cells: [cell("a"), cell("b"), cell("c"), cell("d")],
});
const change = (fields) => ({
  event: "screen", sequence: 7, segment: "b1", number: 4, base: false, previous: 3, rows: 2, cols: 2,
  cursor: { row: 1, col: 1, visible: true },
  changed: [{ row: 1, cells: [cell("x", 1, 2), cell("y")] }],
  ...fields,
});

test("a change replaces the rows it carries in the screen of the message it names and takes its cursor", async () => {
  const first = applyScreenMessage(null, grid());
  const next = applyScreenMessage(first, change());
  assert.deepEqual(next, {
    sequence: 7,
    segment: "b1",
    number: 4,
    screen: { rows: 2, cols: 2, cursor: { row: 1, col: 1, visible: true }, cells: [cell("a"), cell("b"), cell("x", 1, 2), cell("y")] },
  });
  assert.deepEqual(first.screen.cells, [cell("a"), cell("b"), cell("c"), cell("d")], "a change does not alter the earlier screen");
  const full = applyScreenMessage(null, { ...grid(), number: 4, cursor: { row: 1, col: 1, visible: true },
    cells: [cell("a"), cell("b"), cell("x", 1, 2), cell("y")] });
  assert.equal(await screenHash(next.screen), await screenHash(full.screen), "a change gives the hash of the full screen");
  const cursorOnly = applyScreenMessage(next, change({ number: 5, previous: 4, changed: [], cursor: { row: 0, col: 1, visible: false } }));
  assert.deepEqual(cursorOnly.screen.cursor, { row: 0, col: 1, visible: false });
});

test("a change that does not follow the screen it names is refused with the member that differs", () => {
  const first = applyScreenMessage(null, grid());
  assert.throws(() => applyScreenMessage(null, change()), { message: "screen message: a change needs the screen of number 3, found none" });
  // Two messages without an input between them have the same sequence, so a change names the number of the message it changes.
  const lost = applyScreenMessage(first, change());
  assert.throws(() => applyScreenMessage(first, change({ number: 5, previous: 4 })), { message: "screen message: a change of previous 4 does not follow number 3" });
  assert.equal(lost.sequence, first.sequence, "the change has the sequence of the screen it changes");
  assert.throws(() => applyScreenMessage(first, { ...grid(), number: 0 }), { message: "screen message: number must be an integer from 1, found 0" });
  assert.throws(() => applyScreenMessage(first, change({ segment: "b2" })), { message: "screen message: a change of segment b2 does not follow segment b1" });
  assert.throws(() => applyScreenMessage(first, change({ cols: 3 })), { message: "screen message: a change of size 2x3 does not follow size 2x2" });
  assert.throws(() => applyScreenMessage(first, change({ changed: [{ row: 1, cells: [cell()] }] })), { message: "screen message: changed[0].cells must hold 2 cells, found 1" });
  assert.throws(() => applyScreenMessage(first, change({ changed: [{ row: 2, cells: [cell(), cell()] }] })), { message: "screen message: changed[0].row must be an integer from 0 to 1, found 2" });
  assert.throws(() => applyScreenMessage(first, change({ changed: [{ row: 1, cells: [cell(), cell()] }, { row: 1, cells: [cell(), cell()] }] })), { message: "screen message: changed[1].row must be greater than 1, found 1" });
  assert.throws(() => applyScreenMessage(first, { ...grid(), base: undefined }), { message: "screen message: base must be true or false, found undefined" });
  assert.throws(() => applyScreenMessage(first, change({ changed: undefined })), { message: "screen message: changed must be an array, found undefined" });
});
