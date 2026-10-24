import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTerminalStageCoherent,
  sameTerminalComposition,
  terminalComposeMatchesPreedit,
  terminalLineBeforeCursor,
  terminalCompositionState,
  visibleInputBeforeCursor,
  startTerminalStatusObserver,
  waitForStateEvent,
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

test("composition equality keeps ranges and cursor position while ignoring blink presentation", () => {
  const compose = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const cursor = { row: 2, col: 9, focused: true, visible: true, blinking: true, blinkVisible: false,
    drawn: { shape: "beam", blinking: true }, preedit: { ...compose } };
  const changedPresentation = { ...cursor, visible: false, blinkVisible: true,
    drawn: { shape: "beam", blinking: false } };

  assert.equal(sameTerminalComposition(terminalCompositionState(compose, cursor),
    terminalCompositionState(compose, changedPresentation)), true);
  assert.equal(sameTerminalComposition(terminalCompositionState(compose, cursor),
    terminalCompositionState({ ...compose, markedRange: null }, changedPresentation)), false);
  assert.equal(sameTerminalComposition(terminalCompositionState(compose, cursor),
    terminalCompositionState(compose, { ...changedPresentation, col: 8 })), false);
});

test("composition state rejects missing or invalid wire fields", () => {
  const compose = { text: "ㅏ", markedRange: { length: 1, location: 0 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const cursor = { row: 0, col: 1, focused: true, preedit: { ...compose } };

  assert.doesNotThrow(() => terminalCompositionState(compose, cursor));
  assert.equal(terminalComposeMatchesPreedit(compose, cursor), true);
  assert.throws(() => terminalCompositionState((({ markedRange, ...value }) => value)(compose), cursor),
    /terminal\.compose\.markedRange is required/);
  assert.throws(() => terminalCompositionState({ ...compose, text: 1 }, cursor), /terminal\.compose\.text must be a string/);
  assert.throws(() => terminalCompositionState({ ...compose, attributed: 1 }, cursor),
    /terminal\.compose\.attributed must be a boolean/);
  assert.throws(() => terminalCompositionState(compose, { ...cursor,
    preedit: (({ markedRange, ...value }) => value)(cursor.preedit) }), /cursor\.preedit\.markedRange is required/);
  assert.throws(() => terminalCompositionState(compose, { ...cursor, preedit: { ...cursor.preedit, text: 1 } }),
    /cursor\.preedit\.text must be a string/);
  assert.throws(() => terminalCompositionState(compose, { ...cursor, preedit: { ...cursor.preedit, attributed: 1 } }),
    /cursor\.preedit\.attributed must be a boolean/);
  assert.equal(terminalComposeMatchesPreedit(compose, { ...cursor, preedit: null }), false);
});

test("a null protocol preedit matches only a valid empty composition", () => {
  const cursor = { row: 0, col: 1, focused: true, preedit: null };
  const empty = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const emptyClear = { ...empty, selectedRange: { length: 0, location: 0 } };

  assert.deepEqual(terminalCompositionState(emptyClear, cursor).cursor.preedit, { kind: "none" });
  assert.equal(terminalComposeMatchesPreedit(emptyClear, cursor), true);
  assert.equal(terminalComposeMatchesPreedit(empty, { ...cursor, preedit: undefined }), true);
  assert.equal(terminalComposeMatchesPreedit({ ...emptyClear, selectedRange: { location: 0, length: 1 } }, cursor), false);
  assert.equal(terminalComposeMatchesPreedit({ ...emptyClear, markedRange: { location: 0, length: 0 } }, cursor), false);
});

test("an initial managed until does not release the manual terminal status watch", async () => {
  const listeners = new Set();
  const requests = [];
  let watched = false;
  const session = {
    window: "main",
    client: { on(_name, listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async request(method, params) {
      requests.push({ method, ...params });
      if (method === "status.watch") watched = true;
      if (method === "status.unwatch") watched = false;
      return null;
    },
    async until(name, predicate, _message, { surface }) {
      requests.push({ method: "managed-watch", name, surface });
      watched = true;
      assert.equal(predicate({ text: "" }), true);
      requests.push({ method: "managed-unwatch", name, surface });
      watched = false;
      return { text: "" };
    },
  };
  const observer = await startTerminalStatusObserver(session, "surface-1");
  if (watched) {
    for (const listener of listeners) listener({ window: "main", surface: "surface-1",
      name: "terminal.compose", value: { text: "ㅏ" } });
  }

  assert.equal(watched, true, "the manual status watch must remain after the initial managed until");
  assert.equal(observer.events.length, 1, "the first compose notification must reach the observer");
  assert.deepEqual(requests.map((request) => request.method), [
    "managed-watch", "managed-unwatch", "status.watch", "status.watch", "status.watch",
  ]);
  await observer.stop();
});

test("a status notification delivered during a sample satisfies the sample's original event offset", async () => {
  const events = [];
  const listeners = new Set();
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const sampleOffset = events.length;
  // Status reads can yield while a notification is delivered; it must still count as newer than this sample.
  await Promise.resolve().then(() => {
    events.push({ name: "terminal.compose", value: { text: "ㅏ" } });
    for (const listener of listeners) listener();
  });

  const event = await waitForStateEvent(events, sampleOffset, subscribe, "sample", 10);
  assert.equal(event.name, "terminal.compose");
  assert.equal(event.value.text, "ㅏ");
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

test("requires coherent base screen presentation without equating a later overlay frame", () => {
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
  const region = { presented: { generation: 2, raster: 3, sequence: 4 } };

  assertTerminalStageCoherent({ screen: dto, region, compose, cursor, stateEvents });
  assert.throws(() => assertTerminalStageCoherent({ screen: dto,
    region: { presented: { generation: 1, raster: 3, sequence: 4 } }, compose, cursor, stateEvents }),
  /generation differs/);
  assert.throws(() => assertTerminalStageCoherent({ screen: dto,
    region: { presented: { generation: 2, raster: 2, sequence: 4 } }, compose, cursor, stateEvents }),
  /raster differs/);
  assert.doesNotThrow(() => assertTerminalStageCoherent({ screen: dto,
    region: { presented: { generation: 2, raster: 3, sequence: 12 } }, compose, cursor, stateEvents }));
  assert.throws(() => assertTerminalStageCoherent({ screen: dto,
    region: { presented: { generation: 2, raster: 3, sequence: 3 } }, compose, cursor, stateEvents }),
  /base screen frame/);
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
