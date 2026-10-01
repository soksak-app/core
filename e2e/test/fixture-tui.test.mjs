import assert from "node:assert/strict";
import test from "node:test";

import { HEADER, HEADER_WORD, PROMPT, parseInput, render, screenLines, select, selectedRange } from "../fixture-tui.mjs";

test("SGR mouse reports are parsed with zero-based cells, and a cut report is kept for the next input", () => {
  assert.deepEqual(parseInput("\x1b[<0;6;2Mq\x1b[<32;9;2M\x1b[<0;1"), {
    events: [{ code: 0, col: 5, row: 1, release: false }, { code: 32, col: 8, row: 1, release: false }],
    keys: "q", rest: "\x1b[<0;1",
  });
  assert.deepEqual(parseInput("\x1b[<0;1;3m").events, [{ code: 0, col: 0, row: 2, release: true }]);
  assert.throws(() => parseInput("\x1b[<0;x;3M"), /invalid mouse report/);
});

test("a drag selects the cells from the press up to the release cell, and a click clears the selection", () => {
  const column = HEADER.indexOf(HEADER_WORD);
  let selection = null;
  // ?1003 은 누르지 않은 움직임도 보고한다. 그 보고는 선택을 바꾸지 않는다.
  selection = select(selection, { code: 35, col: 40, row: 1, release: false });
  assert.equal(selection, null);
  selection = select(selection, { code: 0, col: column, row: 1, release: false });
  selection = select(selection, { code: 32, col: column + 3, row: 1, release: false });
  selection = select(selection, { code: 0, col: column + HEADER_WORD.length, row: 1, release: true });
  assert.deepEqual(selectedRange(selection), { row: 1, from: column, to: column + HEADER_WORD.length });
  assert.ok(render(4, 30, selection).includes(`\x1b[7m${HEADER_WORD}\x1b[27m`));
  selection = select(selection, { code: 35, col: 2, row: 2, release: false });
  assert.deepEqual(selectedRange(selection), { row: 1, from: column, to: column + HEADER_WORD.length }, "a hover changed the selection");
  selection = select(selection, { code: 0, col: 2, row: 2, release: false });
  selection = select(selection, { code: 0, col: 2, row: 2, release: true });
  assert.equal(selectedRange(selection), null, "a click left a selection");
  assert.ok(!render(4, 30, selection).includes("\x1b[7m"));
});

test("the screen shows the header on the second row and the prompt above the last row", () => {
  const lines = screenLines(10, 40);
  assert.equal(lines[1].trimEnd(), HEADER);
  assert.equal(lines[8].trimEnd(), `> ${PROMPT}`);
  assert.ok(lines.every((line) => line.length === 40));
});
