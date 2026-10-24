import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTerminalStageCoherent,
  sameTerminalComposition,
  terminalComposeMatchesPreedit,
  terminalLineBeforeCursor,
  terminalCompositionState,
  terminalInputReceiptMatches,
  terminalObserverStatusesMatch,
  visibleInputBeforeCursor,
  startTerminalStatusObserver,
  waitForObservedStatusEvent,
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

test("a fresh compose and cursor update can use unchanged known PTY rows", () => {
  const baseline = {
    compose: { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false },
    cursor: { row: 0, col: 8, focused: true, preedit: null },
    screen: screen([[cell("$"), cell(" ")]]),
  };
  const compose = { text: "ㅏ", markedRange: null, selectedRange: { location: 1, length: 0 },
    replacementRange: null, attributed: false };
  const cursor = { row: 0, col: 8, focused: true, preedit: { ...compose } };
  const currentScreen = { ...screen([[cell("$"), cell(" ")]]), frame: { ...baseline.screen.frame, sequence: 5 } };
  const freshEvents = [{ name: "terminal.compose", value: compose }];

  assert.deepEqual(currentScreen.rows, baseline.screen.rows, "PTY rows remain unchanged while composition changes");
  assert.equal(terminalObserverStatusesMatch(freshEvents, baseline, { compose, cursor, screen: currentScreen }), true,
    "a fresh compose notification and coherent current cursor may reuse unchanged known rows");
});

test("a fresh cursor event can report a changed preedit without compose or screen events", () => {
  const baseline = {
    compose: { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false },
    cursor: { row: 0, col: 8, focused: true, preedit: null },
    screen: screen([[cell("$"), cell(" ")]]),
  };
  const compose = { text: "ㅏ", markedRange: null, selectedRange: { location: 1, length: 0 },
    replacementRange: null, attributed: false };
  const cursor = { row: 0, col: 8, focused: true, preedit: { ...compose } };
  const currentScreen = { ...screen([[cell("$"), cell(" ")]]), frame: { ...baseline.screen.frame, sequence: 5 } };

  assert.equal(terminalObserverStatusesMatch([{ name: "terminal.cursor", value: cursor }], baseline,
    { compose, cursor, screen: currentScreen }), true);
});

test("a fresh screen event can accompany a coherent composition reread", () => {
  const baseline = {
    compose: { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false },
    cursor: { row: 0, col: 8, focused: true, preedit: null },
    screen: screen([[cell("$"), cell(" ")]]),
  };
  const compose = { text: "ㅏ", markedRange: null, selectedRange: { location: 1, length: 0 },
    replacementRange: null, attributed: false };
  const cursor = { row: 0, col: 8, focused: true, preedit: { ...compose } };
  const currentScreen = { ...screen([[cell("$"), cell("x")]]), frame: { ...baseline.screen.frame, sequence: 5 } };

  assert.equal(terminalObserverStatusesMatch([{ name: "terminal.screen", value: currentScreen.rows }], baseline,
    { compose, cursor, screen: currentScreen }), true);
});

test("per-key IME trace receipts identify the expected native or terminal callback", () => {
  assert.equal(terminalInputReceiptMatches([{ kind: "native-compose", text: "ㅏ" }], "k"), true);
  assert.equal(terminalInputReceiptMatches([{ kind: "terminal-input", input: { type: "compose", text: "ㅏ" } }], "k"), true);
  assert.equal(terminalInputReceiptMatches([{ kind: "native-key", key: "Backspace" }], "Backspace"), true);
  assert.equal(terminalInputReceiptMatches([{ kind: "terminal-input", input: { type: "command", selector: "deleteBackward:" } }],
    "Backspace"), true);
  assert.equal(terminalInputReceiptMatches([{ kind: "native-insert", text: " " }], "Space"), true);
  assert.equal(terminalInputReceiptMatches([{ kind: "terminal-input", input: { type: "insert", text: " " } }], "Space"), true);
  assert.equal(terminalInputReceiptMatches([{ kind: "native-compose", text: "ㅏ" }], "Backspace"), false);
  assert.equal(terminalInputReceiptMatches([], "k"), false);
  assert.throws(() => terminalInputReceiptMatches([], "Enter"), /no receipt rule for key/);
});

test("a terminal observer requires a fresh semantic input status, not blink-only state", () => {
  const compose = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const cursor = { row: 0, col: 8, focused: true, preedit: null, blinkVisible: true };
  const baseline = { compose, cursor, screen: screen([[cell("$"), cell(" ")]]) };
  const presentationOnlyCursor = { ...cursor, blinkVisible: false };
  const unchanged = { compose, cursor: presentationOnlyCursor, screen: baseline.screen };

  assert.equal(terminalObserverStatusesMatch([{ name: "terminal.cursor", value: presentationOnlyCursor }], baseline, unchanged), false);
  assert.equal(terminalObserverStatusesMatch([], baseline, { ...unchanged, compose: { ...compose, text: "ㅏ" } }), false);
  assert.equal(terminalObserverStatusesMatch([{ name: "terminal.cursor", value: { ...cursor, focused: false } }],
    baseline, { ...unchanged, cursor: { ...cursor, focused: false } }), false,
  "losing terminal focus cannot count as key input progress");
});

test("a terminal observer rejects stale changed state and rows without a matching event", () => {
  const empty = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const cursor = { row: 0, col: 8, focused: true, preedit: null };
  const baseline = { compose: empty, cursor, screen: screen([[cell("$"), cell(" ")]]) };
  const compose = { text: "ㅏ", markedRange: null, selectedRange: { location: 1, length: 0 },
    replacementRange: null, attributed: false };
  const currentCursor = { ...cursor, preedit: { ...compose } };
  const current = { compose, cursor: currentCursor, screen: baseline.screen };

  assert.equal(terminalObserverStatusesMatch([{ name: "terminal.compose", value: { ...compose, text: "ㅎ" } }],
    baseline, current), false, "a stale compose event must not bless a newer state");
  assert.equal(terminalObserverStatusesMatch([
    { name: "terminal.compose", value: compose },
    { name: "terminal.cursor", value: { ...currentCursor, col: 9 } },
  ], baseline, current), false, "a stale cursor event must not bless a newer state");
  assert.equal(terminalObserverStatusesMatch([{ name: "terminal.compose", value: compose }], baseline,
    { ...current, screen: { ...screen([[cell("$"), cell("x")]]), frame: { ...baseline.screen.frame, sequence: 5 } } }), false,
  "changed PTY rows require their own matching screen notification");
  assert.equal(terminalObserverStatusesMatch([
    { name: "terminal.compose", value: compose },
    { name: "terminal.screen", value: [[cell("$"), cell("stale")]] },
  ], baseline, current), false, "a stale screen event must not bless the current rows");
  assert.throws(() => terminalObserverStatusesMatch([
    { name: "terminal.compose", value: compose },
    { name: "terminal.screen", value: null },
  ], baseline, current), /terminal\.screen notification must be raw cell rows/);
});

test("a matching screen update can establish changed PTY rows with unchanged composition", () => {
  const compose = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const cursor = { row: 0, col: 8, focused: true, preedit: null };
  const baseline = { compose, cursor, screen: screen([[cell("$"), cell(" ")]]) };
  const currentScreen = { ...screen([[cell("$"), cell("x")]]), frame: { ...baseline.screen.frame, sequence: 5 } };

  assert.equal(terminalObserverStatusesMatch([{ name: "terminal.screen", value: currentScreen.rows }], baseline,
    { compose, cursor, screen: currentScreen }), true);
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

test("a managed cursor until releases the observer's raw cursor watch", async () => {
  const listeners = new Set();
  const requests = [];
  const watched = new Set();
  const session = {
    window: "main",
    client: { on(_name, listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async request(method, { name }) {
      requests.push({ method, name });
      if (method === "status.watch") watched.add(name);
      if (method === "status.unwatch") watched.delete(name);
      return null;
    },
    async until(name, predicate, _message, { surface }) {
      await this.request("status.watch", { name, surface });
      const value = name === "terminal.compose" ? { text: "" } : { focused: true };
      assert.equal(predicate(value), true);
      await this.request("status.unwatch", { name, surface });
      return value;
    },
  };
  const observer = await startTerminalStatusObserver(session, "surface-1");

  await session.until("terminal.cursor", (cursor) => cursor.focused === true,
    "terminal focus did not return", { surface: "surface-1" });
  if (watched.has("terminal.cursor")) {
    for (const listener of listeners) listener({ window: "main", surface: "surface-1",
      name: "terminal.cursor", value: { focused: true } });
  }

  assert.deepEqual(requests.filter((request) => request.method === "status.watch" || request.method === "status.unwatch"), [
    { method: "status.watch", name: "terminal.compose" },
    { method: "status.unwatch", name: "terminal.compose" },
    { method: "status.watch", name: "terminal.compose" },
    { method: "status.watch", name: "terminal.cursor" },
    { method: "status.watch", name: "terminal.screen" },
    { method: "status.watch", name: "terminal.cursor" },
    { method: "status.unwatch", name: "terminal.cursor" },
  ]);
  assert.equal(watched.has("terminal.cursor"), false);
  assert.equal(observer.events.some((event) => event.name === "terminal.cursor"), false,
    "the old managed focus wait drops the cursor notification from the raw observer");
  await observer.stop();
});

test("focus waits on the existing raw status stream after reference handoff", async () => {
  const listeners = new Set();
  const requests = [];
  const watched = new Set();
  const session = {
    window: "main",
    client: { on(_name, listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async request(method, { name }) {
      requests.push({ method, name });
      if (method === "status.watch") watched.add(name);
      if (method === "status.unwatch") watched.delete(name);
      return null;
    },
    async until(name, predicate, _message, { surface }) {
      await this.request("status.watch", { name, surface });
      const value = name === "terminal.compose" ? { text: "" } : { focused: true };
      assert.equal(predicate(value), true);
      await this.request("status.unwatch", { name, surface });
      return value;
    },
  };
  const observer = await startTerminalStatusObserver(session, "surface-1");
  const offset = observer.events.length;
  let notify;
  const result = waitForObservedStatusEvent(observer.events, offset, (listener) => {
    notify = listener;
    return () => { notify = undefined; };
  }, "terminal.cursor", (cursor) => cursor?.focused === true, "focus wait", 20);
  for (const listener of listeners) listener({ window: "main", surface: "surface-1",
    name: "terminal.cursor", value: { focused: false } });
  notify();
  assert.equal(notify !== undefined, true, "stale focus must not resolve or remove the waiter");
  for (const listener of listeners) listener({ window: "main", surface: "surface-1",
    name: "terminal.cursor", value: { focused: true } });
  notify();

  const event = await result;
  assert.equal(event.value.focused, true);
  assert.equal(watched.has("terminal.cursor"), true, "focus wait must preserve the raw cursor watch");
  assert.equal(requests.some((request) => request.method === "status.unwatch" && request.name === "terminal.cursor"), false);
  await observer.stop();
  assert.equal(watched.size, 0, "observer cleanup must release each raw watch");
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

test("the observer waits for the initial screen status after watch acknowledgements", async () => {
  const listeners = new Set();
  const events = [];
  const wakeups = new Set();
  const values = {
    "terminal.compose": { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false },
    "terminal.cursor": { row: 0, col: 2, focused: true, frame: { generation: 1, raster: 2, sequence: 3 },
      render: { frame: { generation: 1, raster: 2, sequence: 3 } }, preedit: null },
    "terminal.screen": [[{ ch: "$", width: 1 }, { ch: " ", width: 1 }]],
  };
  const session = {
    window: "main",
    client: { on(_name, listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    async request(method, { name }) {
      assert.ok(["status.watch", "status.unwatch"].includes(method));
      return null;
    },
    async until(name, predicate) {
      assert.equal(name, "terminal.compose");
      assert.equal(predicate(values[name]), true);
      return values[name];
    },
  };
  const observer = await startTerminalStatusObserver(session, "surface-1", (event) => {
    events.push(event);
    for (const wake of [...wakeups]) wake();
  });
  assert.equal(events.some((event) => event.name === "terminal.screen"), false,
    "watch acknowledgement must not be mistaken for the initial value notification");
  const waiting = waitForObservedStatusEvent(events, 0, (wake) => {
    wakeups.add(wake);
    return () => wakeups.delete(wake);
  }, "terminal.screen", Array.isArray, "initial screen status", 100);
  const event = { window: "main", surface: "surface-1", name: "terminal.screen", value: values["terminal.screen"] };
  for (const listener of listeners) listener(event);
  const screenEvent = await waiting;
  assert.deepEqual(screenEvent.value, values["terminal.screen"]);
  await observer.stop();
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
