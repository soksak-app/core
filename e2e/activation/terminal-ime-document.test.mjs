import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTerminalStageCoherent,
  terminalLineBeforeCursor,
  visibleInputBeforeCursor,
} from "./terminal-ime-document.mjs";

function screen(rows) {
  return { frame: { generation: 2, raster: 3, sequence: 4 }, rows };
}

function cell(ch, width = 1) {
  return { ch, width };
}

test("reads visible input from terminal.screen.read rows and appends preedit once", () => {
  const dto = screen([[cell("$"), cell(" "), cell("ㅏ"), cell("ㅏ")] ]);
  const cursor = { row: 0, col: 4 };
  const prompt = { row: 0, col: 0, text: "$ " };

  assert.equal(terminalLineBeforeCursor(dto, cursor), "$ ㅏㅏ");
  assert.equal(visibleInputBeforeCursor(dto, cursor, prompt, "ㅏ"), "ㅏㅏㅏ");
  assert.equal(visibleInputBeforeCursor(dto, cursor, prompt, ""), "ㅏㅏ");
});

test("preserves a committed trailing space after the prompt", () => {
  const dto = screen([[cell("$"), cell(" "), cell("ㅏ"), cell(" ")] ]);
  assert.equal(visibleInputBeforeCursor(dto, { row: 0, col: 4 }, { row: 0, col: 0, text: "$ " }, ""), "ㅏ ");
});

test("counts wide cells by their declared width across a wrapped input row", () => {
  const dto = screen([[cell("$"), cell(" ")], [cell("界", 2)]]);
  const cursor = { row: 1, col: 2 };
  const prompt = { row: 0, col: 0, text: "$ " };

  assert.equal(visibleInputBeforeCursor(dto, cursor, prompt, "ㅏ"), "界ㅏ");
});

test("rejects a cursor inside a width-two cell", () => {
  const dto = screen([[cell("$"), cell(" "), cell("界", 2)]]);
  assert.throws(() => visibleInputBeforeCursor(dto, { row: 0, col: 3 },
    { row: 0, col: 0, text: "$ " }, ""), /splits a display cell/);
});

test("requires coherent compose, cursor, screen notification and presented frame", () => {
  const rows = [[cell("$"), cell(" "), cell("ㅏ")]];
  const dto = screen(rows);
  const compose = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 } };
  const cursor = { row: 0, col: 2, preedit: { ...compose } };
  const stateEvents = [
    { name: "terminal.compose", value: compose },
    { name: "terminal.cursor", value: cursor },
    { name: "terminal.screen", value: rows },
  ];
  const region = { presented: { generation: 2, raster: 3, sequence: 5 } };

  assertTerminalStageCoherent({ screen: dto, region, compose, cursor, stateEvents });
  assert.throws(() => assertTerminalStageCoherent({ screen: dto,
    region: { presented: { generation: 1, raster: 3, sequence: 5 } }, compose, cursor, stateEvents }),
  /generation differs/);
  assert.throws(() => assertTerminalStageCoherent({ screen: dto, region, compose,
    cursor: { ...cursor, preedit: { text: "" } }, stateEvents }), /preedit differs/);
  assert.throws(() => assertTerminalStageCoherent({ screen: dto, region, compose,
    cursor: { ...cursor, preedit: { ...cursor.preedit, markedRange: { location: 0, length: 0 } } }, stateEvents }),
  /markedRange differs/);
  assert.throws(() => assertTerminalStageCoherent({ screen: dto, region, compose,
    cursor: { ...cursor, preedit: { ...cursor.preedit, selectedRange: { location: 0, length: 1 } } }, stateEvents }),
  /selectedRange differs/);
  assert.throws(() => assertTerminalStageCoherent({ screen: dto, region, compose, cursor,
    stateEvents: [...stateEvents.slice(0, 2), { name: "terminal.screen", value: { rows } }] }),
  /raw cell rows array/);
});
