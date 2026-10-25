import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTerminalStageCoherent,
  sameTerminalComposition,
  terminalComposeMatchesPreedit,
  terminalLineBeforeCursor,
  terminalInputBaselineAfterReference,
  terminalCompositionState,
  assertInputTraceDelivery,
  inputTraceTransactions,
  terminalInputReceiptMatches,
  observeTerminalBaseline,
  readTerminalObservationSnapshot,
  initialCursorFrameMatchesScreen,
  terminalObserverStatusesMatch,
  terminalStageMatchesReference,
  selectCoherentTerminalObservation,
  visibleInputBeforeCursor,
  startTerminalStatusObserver,
  waitForObservedStatusEvent,
  waitForStateEvent,
  waitForTerminalStage,
  terminalStageEvents,
} from "./terminal-ime-document.mjs";

function screen(rows) {
  return { frame: { generation: 2, raster: 3, sequence: 4 }, rows };
}

function cell(ch, width = 1) {
  return { ch, width };
}

test("initial cursor baseline requires the accepted screen frame", () => {
  const acceptedScreen = screen([]);
  const current = { frame: { ...acceptedScreen.frame }, render: { frame: { ...acceptedScreen.frame } } };
  assert.equal(initialCursorFrameMatchesScreen(current, acceptedScreen), true);
  assert.equal(initialCursorFrameMatchesScreen({ ...current,
    frame: { ...current.frame, sequence: current.frame.sequence - 1 },
    render: { frame: { ...current.frame, sequence: current.frame.sequence - 1 } } }, acceptedScreen), false,
  "an earlier cursor frame must not establish the current baseline");
  assert.equal(initialCursorFrameMatchesScreen({ ...current,
    render: { frame: { ...current.frame, sequence: current.frame.sequence + 1 } } }, acceptedScreen), false,
  "renderer metadata from another frame must not establish the baseline");
});

test("initial cursor baseline accepts null render only for the accepted screen frame", () => {
  const acceptedScreen = screen([]);
  const current = { row: 0, col: 8, focused: true,
    frame: { ...acceptedScreen.frame }, render: null };
  assert.equal(initialCursorFrameMatchesScreen(current, acceptedScreen), true,
    "a null render does not invalidate the exact cursor frame identity");
  assert.equal(initialCursorFrameMatchesScreen({ ...current,
    frame: { ...current.frame, sequence: current.frame.sequence - 1 } }, acceptedScreen), false,
  "an earlier cursor frame cannot establish the prompt baseline");
  assert.equal(initialCursorFrameMatchesScreen({ ...current,
    frame: { ...current.frame, sequence: Number.NaN } }, acceptedScreen), false,
  "malformed cursor frame identity cannot establish the baseline");
  assert.equal(initialCursorFrameMatchesScreen({ ...current,
    render: { frame: { ...current.frame, sequence: current.frame.sequence + 1 } } }, acceptedScreen), false,
  "non-null renderer identity must match the cursor frame");
});

test("the initial terminal baseline observes a frame advanced during its read", { timeout: 5000 }, async () => {
  const listeners = new Set();
  const frame = { generation: 2, raster: 3, sequence: 5 };
  const cursor = { row: 0, col: 8, focused: true, frame, render: null };
  const publish = (event) => { for (const listener of listeners) listener(event); };
  const observed = await observeTerminalBaseline(async (listener) => {
    listeners.add(listener);
    return { async stop() { listeners.delete(listener); } };
  }, async () => {
    publish({ name: "terminal.cursor", value: cursor });
    return { screen: { frame, rows: [] }, cursor };
  });
  try {
    assert.ok(observed.events.some((event) => event.name === "terminal.cursor" &&
      event.value.frame?.generation === observed.baseline.screen.frame.generation &&
      event.value.frame?.raster === observed.baseline.screen.frame.raster &&
      event.value.frame?.sequence === observed.baseline.screen.frame.sequence),
    "the observer missed the cursor notification for the baseline frame");
  } finally {
    await observed.observer.stop();
  }
});

test("a failed initial baseline stops its observer and preserves the read error", { timeout: 5000 }, async () => {
  const failure = new Error("baseline read failed");
  let stopped = false;
  await assert.rejects(observeTerminalBaseline(async () => ({
    async stop() { stopped = true; },
  }), async () => { throw failure; }), (error) => error === failure);
  assert.equal(stopped, true, "the observer remains active after a failed baseline read");
});

test("terminal observation reads status pairs concurrently around the screen sample", { timeout: 5000 }, async () => {
  const started = [];
  const beforeCompose = deferred();
  const beforeCursor = deferred();
  const screen = deferred();
  const afterCompose = deferred();
  const afterCursor = deferred();
  const host = deferred();
  const readStarted = new Map(["before.compose", "before.cursor", "screen", "after.compose", "after.cursor", "host"]
    .map((name) => [name, deferred()]));
  const markStarted = (name) => { started.push(name); readStarted.get(name).resolve(); };
  let composeReads = 0;
  let cursorReads = 0;
  const task = readTerminalObservationSnapshot({
    readCompose() {
      const name = composeReads++ === 0 ? "before.compose" : "after.compose";
      markStarted(name);
      return composeReads === 1 ? beforeCompose.promise : afterCompose.promise;
    },
    readCursor() {
      const name = cursorReads++ === 0 ? "before.cursor" : "after.cursor";
      markStarted(name);
      return cursorReads === 1 ? beforeCursor.promise : afterCursor.promise;
    },
    readScreen() { markStarted("screen"); return screen.promise; },
    readHost() { markStarted("host"); return host.promise; },
  });
  await readStarted.get("before.compose").promise;
  const beforeStarted = started.slice();
  beforeCompose.resolve("compose-before");
  await readStarted.get("before.cursor").promise;
  beforeCursor.resolve("cursor-before");
  await readStarted.get("screen").promise;
  const afterScreenStarted = started.slice();
  screen.resolve("screen");
  await readStarted.get("after.compose").promise;
  const afterStarted = started.slice();
  afterCompose.resolve("compose-after");
  await readStarted.get("after.cursor").promise;
  afterCursor.resolve("cursor-after");
  await readStarted.get("host").promise;
  host.resolve("host-after");
  const snapshot = await task;

  assert.deepEqual(beforeStarted, ["before.compose", "before.cursor"]);
  assert.deepEqual(afterScreenStarted, ["before.compose", "before.cursor", "screen"]);
  assert.deepEqual(afterStarted, ["before.compose", "before.cursor", "screen", "after.compose", "after.cursor"]);
  assert.deepEqual(snapshot, { compose: "compose-before", cursor: "cursor-before", screen: "screen",
    currentCompose: "compose-after", currentCursor: "cursor-after", host: "host-after" });
});

test("terminal observation reports every failed read in each concurrent phase", { timeout: 5000 }, async () => {
  const composeError = new Error("compose unavailable");
  const cursorError = new Error("cursor unavailable");
  const result = readTerminalObservationSnapshot({
    readCompose() { throw composeError; },
    readCursor() { throw cursorError; },
    readScreen() { assert.fail("screen must not run after a failed before-status batch"); },
    readHost() { assert.fail("after-status reads must not run after a failed batch"); },
  });
  await assert.rejects(result, (error) => error instanceof AggregateError && error.errors.length === 2 &&
    error.errors.some((entry) => entry.message === "terminal.compose read failed" && entry.cause === composeError) &&
    error.errors.some((entry) => entry.message === "terminal.cursor read failed" && entry.cause === cursorError));

  const afterComposeError = new Error("current compose unavailable");
  const afterCursorError = new Error("current cursor unavailable");
  let composeReads = 0;
  let cursorReads = 0;
  await assert.rejects(readTerminalObservationSnapshot({
    readCompose() {
      if (composeReads++ === 0) return "compose-before";
      throw afterComposeError;
    },
    readCursor() {
      if (cursorReads++ === 0) return "cursor-before";
      throw afterCursorError;
    },
    readScreen() { return "screen"; },
    readHost() { assert.fail("host presentation must not be read after failed terminal reads"); },
  }), (error) => error instanceof AggregateError && error.errors.length === 2 &&
    error.errors.some((entry) => entry.message === "terminal.compose read failed" && entry.cause === afterComposeError) &&
    error.errors.some((entry) => entry.message === "terminal.cursor read failed" && entry.cause === afterCursorError));
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("waits for the seven-vowel Backspace document after a coherent eight-vowel intermediate", { timeout: 5000 }, async () => {
  const empty = { text: "", markedRange: null, selectedRange: { location: 0, length: 0 },
    replacementRange: null, attributed: false };
  const priorCompose = { text: "ㅏㅏ", markedRange: null, selectedRange: { location: 2, length: 0 },
    replacementRange: null, attributed: false };
  const priorCursor = { row: 0, col: 14, focused: true, preedit: { ...priorCompose } };
  const eightVowels = "ㅏ".repeat(8);
  const sevenVowels = "ㅏ".repeat(7);
  const baseline = {
    compose: priorCompose,
    cursor: priorCursor,
    screen: { ...screen([[cell("$"), cell(" "), ...Array.from("ㅏ".repeat(6), (ch) => cell(ch, 2))]]),
      frame: { generation: 2, raster: 3, sequence: 4 } },
  };
  const events = [
    { name: "terminal.compose", value: empty },
    { name: "terminal.cursor", value: { row: 0, col: 18, focused: true, preedit: null } },
    { name: "terminal.screen", value: [[cell("$"), cell(" "), ...Array.from(eightVowels, (ch) => cell(ch, 2))]] },
  ];
  const listeners = new Set();
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const prompt = { row: 0, col: 0, text: "$ " };
  const reads = [];
  let current = {
    compose: empty,
    cursor: { row: 0, col: 18, focused: true, preedit: null },
    screen: { ...screen(events[2].value), frame: { generation: 2, raster: 3, sequence: 5 } },
  };
  let resolveFirstRead;
  const firstRead = new Promise((resolve) => { resolveFirstRead = resolve; });
  const read = async () => {
    const statusEvents = [...events];
    const coherent = terminalObserverStatusesMatch(statusEvents, baseline, current);
    const document = visibleInputBeforeCursor(current.screen, current.cursor, prompt, current.compose.text,
      "Backspace status sample");
    reads.push(document);
    if (reads.length === 1) resolveFirstRead();
    return { coherent, document, stateEvents: statusEvents, ...current };
  };
  const waitForEvent = (after, timeoutMs) => waitForStateEvent(events, after, subscribe, "Backspace status", timeoutMs);
  const waiting = waitForTerminalStage(events, read, waitForEvent, sevenVowels, "Backspace", 1500);

  await firstRead;
  assert.equal(reads[0], eightVowels, "the first coherent reread is the pending eight-vowel document");
  current = {
    compose: empty,
    cursor: { row: 0, col: 16, focused: true, preedit: null },
    screen: { ...screen([[cell("$"), cell(" "), ...Array.from(sevenVowels, (ch) => cell(ch, 2))]]),
      frame: { generation: 2, raster: 3, sequence: 6 } },
  };
  events.push({ name: "terminal.cursor", value: current.cursor });
  events.push({ name: "terminal.screen", value: current.screen.rows });
  for (const listener of [...listeners]) listener();
  const accepted = await waiting;

  assert.deepEqual(reads, [eightVowels, sevenVowels]);
  assert.equal(accepted.document, sevenVowels);
  assert.equal(accepted.coherent, true);
  assert.equal(terminalStageMatchesReference(accepted, sevenVowels), true);
});

test("keeps notifications that arrive after the first status wakes the input stage", { timeout: 5000 }, () => {
  const events = [];
  const keyStartOffset = events.length;
  const screenEvent = { name: "terminal.screen", value: [[cell("$"), cell(" "), cell("ㅏ", 2)]] };
  const cursorEvent = { name: "terminal.cursor", value: { row: 0, col: 4, preedit: null } };

  events.push(screenEvent);
  assert.equal(events.at(keyStartOffset), screenEvent, "the screen notification wakes the first event wait");
  events.push(cursorEvent);

  const stageEvents = terminalStageEvents(events, keyStartOffset);
  assert.deepEqual(stageEvents, [screenEvent, cursorEvent],
    "the original key-start offset must retain the screen and later cursor notifications");
});

test("reads visible input from terminal.screen.read rows and appends preedit once", () => {
  const dto = screen([[cell("$"), cell(" "), cell("ㅏ"), cell("ㅏ")] ]);
  const cursor = { row: 0, col: 4 };
  const prompt = { row: 0, col: 0, text: "$ " };

  assert.equal(terminalLineBeforeCursor(dto, cursor), "$ ㅏㅏ");
  assert.equal(visibleInputBeforeCursor(dto, cursor, prompt, "ㅏ"), "ㅏㅏㅏ");
  assert.equal(visibleInputBeforeCursor(dto, cursor, prompt, ""), "ㅏㅏ");
});

test("reconstructs committed screen text plus only the current marked buffer", () => {
  const committed = "ㅏ".repeat(6);
  const dto = screen([[cell("$"), cell(" "), ...Array.from(committed, (ch) => cell(ch, 2))]]);
  const cursor = { row: 0, col: 14 };
  const prompt = { row: 0, col: 0, text: "$ " };

  assert.equal(visibleInputBeforeCursor(dto, cursor, prompt, "ㅏ"), "ㅏ".repeat(7));
  assert.equal(visibleInputBeforeCursor(dto, cursor, prompt, ""), committed);
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

test("the first terminal key compares against the prompt redrawn after reference focus", () => {
  const empty = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const initialRows = [[...Array.from("zle-check% ", (ch) => cell(ch)), ...Array.from({ length: 100 }, () => cell(" "))]];
  const baseline = {
    compose: empty,
    cursor: { row: 0, col: 11, focused: true, preedit: null },
    screen: { ...screen(initialRows), frame: { generation: 2, raster: 3, sequence: 4 } },
  };
  const redrawnRows = [initialRows[0], [...Array.from("zle-check% ", (ch) => cell(ch)),
    ...Array.from({ length: 100 }, () => cell(" "))]];
  const transitionCursor = { row: 1, col: 11, focused: true, preedit: null,
    frame: { generation: 2, raster: 3, sequence: 6 }, render: null };
  const transition = {
    compose: empty,
    cursor: transitionCursor,
    screen: { ...screen(redrawnRows), frame: { ...transitionCursor.frame } },
  };
  const phaseEvents = [
    { name: "terminal.screen", value: redrawnRows },
    { name: "terminal.cursor", value: transitionCursor },
  ];
  const refreshed = terminalInputBaselineAfterReference(baseline, { row: 0, col: 0, text: "zle-check% " }, {
    compose: empty,
    cursor: transitionCursor,
    screen: transition.screen,
    currentCompose: empty,
    currentCursor: transitionCursor,
  }, phaseEvents);
  assert.equal(refreshed.prompt.row, 1, "the refreshed prompt anchor follows the current cursor row");

  const compose = { text: "ㅏ", markedRange: null, selectedRange: { location: 1, length: 0 },
    replacementRange: null, attributed: false };
  const cursor = { row: 1, col: 11, focused: true, preedit: { ...compose },
    frame: { generation: 2, raster: 3, sequence: 7 } };
  const current = {
    compose,
    cursor,
    screen: { ...transition.screen, frame: { generation: 2, raster: 3, sequence: 6 } },
  };
  const keyEvents = [
    { name: "terminal.compose", value: compose },
    { name: "terminal.cursor", value: cursor },
  ];

  assert.equal(terminalObserverStatusesMatch(keyEvents, baseline, current), false,
    "a stale pre-reference screen baseline must not accept changed rows without a screen event");
  assert.equal(terminalObserverStatusesMatch(keyEvents, refreshed.baseline, current), true,
    "the first-key status comparison starts from the accepted post-reference baseline");
  assert.equal(visibleInputBeforeCursor(current.screen, current.cursor, refreshed.prompt,
    current.compose.text), "ㅏ");
});

test("post-reference baseline accepts a later cursor overlay on the same base rows", () => {
  const empty = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const promptText = "zle-check% ";
  const baselineRows = [[...Array.from(promptText, (ch) => cell(ch)), ...Array.from({ length: 100 }, () => cell(" "))]];
  const baseline = {
    compose: empty,
    cursor: { row: 0, col: 11, focused: true, preedit: null },
    screen: { ...screen(baselineRows), frame: { generation: 2, raster: 3, sequence: 4 } },
  };
  const currentRows = [baselineRows[0], [...Array.from(promptText, (ch) => cell(ch)),
    ...Array.from({ length: 100 }, () => cell(" "))]];
  const frame = { generation: 2, raster: 3, sequence: 7 };
  const cursor = { row: 1, col: 11, focused: true, preedit: null, frame, render: { frame } };
  const screenFrame = { generation: 2, raster: 3, sequence: 6 };
  const snapshot = {
    compose: empty,
    cursor,
    screen: { ...screen(currentRows), frame: screenFrame },
    currentCompose: empty,
    currentCursor: cursor,
  };
  const events = [
    { name: "terminal.screen", value: currentRows },
    { name: "terminal.cursor", value: cursor },
  ];
  const prompt = { row: 0, col: 0, text: promptText };

  const refreshed = terminalInputBaselineAfterReference(baseline, prompt, snapshot, events);
  assert.equal(refreshed.prompt.row, 1);
  assert.equal(refreshed.baseline.screen.frame.sequence, 6);
  assert.equal(refreshed.baseline.cursor.frame.sequence, 7);

  const wrongRender = { ...cursor, render: { frame: { ...frame, sequence: 8 } } };
  assert.throws(() => terminalInputBaselineAfterReference(baseline, prompt, {
    ...snapshot, cursor: wrongRender, currentCursor: wrongRender,
  }, events), /cursor overlay is not coherent with the accepted base screen/,
  "render metadata from another overlay frame must not establish the baseline");
  const earlierCursor = { ...cursor, frame: { ...frame, sequence: 5 }, render: { frame: { ...frame, sequence: 5 } } };
  assert.throws(() => terminalInputBaselineAfterReference(baseline, prompt, {
    ...snapshot, cursor: earlierCursor, currentCursor: earlierCursor,
  }, events), /cursor overlay is not coherent with the accepted base screen/,
  "the base screen must not follow its cursor overlay");
});

test("per-key IME receipts read current native transactions and VT input requests", () => {
  const preedit = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  let sequence = 0;
  const native = (action) => ({ kind: "native-input", sequence: ++sequence, cids: ["input-cid-1"], input: {
    actions: [action], preedit, errors: [],
  } });
  const terminal = (action) => ({ kind: "terminal-input", sequence: ++sequence, cids: ["input-cid-1"], input: {
    operation: "input", actions: [action], preedit,
  } });
  const insert = { type: "insert", text: "ㅏ", replacementRange: null, attributed: true };
  const backspace = { type: "command", selector: "deleteBackward:" };
  const backspaceKey = { type: "key", key: "Backspace", shift: false, alt: false, ctrl: false };
  const characterKey = { type: "key", key: "Char", text: "k", shift: false, alt: false, ctrl: false };
  const space = { type: "insert", text: " ", replacementRange: null, attributed: false };

  assert.equal(terminalInputReceiptMatches([native(insert)], "k"), true);
  assert.equal(terminalInputReceiptMatches([terminal(insert)], "k"), true);
  assert.equal(terminalInputReceiptMatches([native(characterKey)], "k"), true);
  assert.equal(terminalInputReceiptMatches([terminal(characterKey)], "k"), true);
  assert.equal(terminalInputReceiptMatches([native(backspace)], "Backspace"), true);
  assert.equal(terminalInputReceiptMatches([terminal(backspace)], "Backspace"), true);
  assert.equal(terminalInputReceiptMatches([native(backspaceKey)], "Backspace"), true);
  assert.equal(terminalInputReceiptMatches([terminal(backspaceKey)], "Backspace"), true);
  assert.equal(terminalInputReceiptMatches([native(space)], "Space"), true);
  assert.equal(terminalInputReceiptMatches([terminal(space)], "Space"), true);
  assert.equal(terminalInputReceiptMatches([native(insert)], "Backspace"), false);
  assert.equal(terminalInputReceiptMatches([], "k"), false);
  assert.throws(() => terminalInputReceiptMatches([], "Enter"), /no receipt rule for key/);
});

test("physical key receipt counts exclude Backspace commits and Space insertion", { timeout: 5000 }, () => {
  const marked = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: false };
  const empty = { text: "", markedRange: null,
    selectedRange: { location: 0, length: 0 }, replacementRange: null, attributed: false };
  const entries = [];
  let sequence = 0;
  let cid = 0;
  const addTransaction = (actions, preedit) => {
    const inputCid = `f84-replay-${++cid}`;
    entries.push({ kind: "native-input", sequence: sequence++, cids: [inputCid],
      input: { actions, preedit, errors: [] } });
    entries.push({ kind: "terminal-input", sequence: sequence++, cids: [inputCid],
      input: { operation: "input", actions, preedit } });
  };
  addTransaction([], marked);
  for (let index = 0; index < 7; index++) {
    addTransaction([{ type: "insert", text: "ㅏ", replacementRange: null, attributed: false }], marked);
  }
  addTransaction([
    { type: "insert", text: "ㅏ", replacementRange: null, attributed: false },
    { type: "command", selector: "deleteBackward:" },
  ], empty);
  addTransaction([{ type: "insert", text: " ", replacementRange: null, attributed: false }], empty);

  const { native } = assertInputTraceDelivery(entries);
  const receipts = (key) => native.filter((transaction) => terminalInputReceiptMatches(
    entries.filter((entry) => entry.cids[0] === transaction.cids[0]), key));
  assert.equal(receipts("k").length, 8, "Backspace and Space transaction inserts must not count as k presses");
  assert.equal(receipts("Backspace").length, 1);
  assert.equal(receipts("Space").length, 1);
});

test("native input transaction actions acknowledge a committed character key", () => {
  const preedit = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const entry = { kind: "native-input", sequence: 1, input: { actions: [
    { type: "insert", text: "ㅏ", replacementRange: null, attributed: true },
  ], preedit, errors: [] }, cids: ["input-cid-1"] };
  assert.equal(terminalInputReceiptMatches([entry], "k"), true);
});

test("one terminal input request acknowledges a committed character key", () => {
  const preedit = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const entry = { kind: "terminal-input", sequence: 1, input: { operation: "input", actions: [
    { type: "insert", text: "ㅏ", replacementRange: null, attributed: true },
  ], preedit }, cids: ["input-cid-1"] };
  assert.equal(terminalInputReceiptMatches([entry], "k"), true);
});

test("compose-only transactions with empty action arrays retain the preedit receipt", () => {
  const preedit = { text: "ㅎ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const native = { kind: "native-input", sequence: 3, cids: ["input-cid-3"],
    input: { actions: [], preedit, errors: [] } };
  const terminal = { kind: "terminal-input", sequence: 4, cids: ["input-cid-3"],
    input: { operation: "input", actions: [], preedit } };
  assert.equal(terminalInputReceiptMatches([native], "k"), true);
  assert.equal(terminalInputReceiptMatches([terminal], "k"), true);
  assert.deepEqual(assertInputTraceDelivery([native, terminal]).native[0].actions, []);
});

test("native and terminal transactions preserve the ordered focus action", () => {
  const preedit = { text: "ㅎ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const action = { type: "focus", focused: true };
  const native = { kind: "native-input", sequence: 5, cids: ["focus-cid"],
    input: { actions: [action], preedit, errors: [] } };
  const terminal = { kind: "terminal-input", sequence: 6, cids: ["focus-cid"],
    input: { operation: "input", actions: [action], preedit } };
  assert.deepEqual(assertInputTraceDelivery([native, terminal]).native[0].actions, [action]);
});

test("focus-only transactions do not acknowledge a key from retained preedit", () => {
  const preedit = { text: "ㅎ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const action = { type: "focus", focused: false };
  const native = { kind: "native-input", sequence: 7, cids: ["focus-cid"],
    input: { actions: [action], preedit, errors: [] } };
  const terminal = { kind: "terminal-input", sequence: 8, cids: ["focus-cid"],
    input: { operation: "input", actions: [action], preedit } };
  assert.deepEqual(assertInputTraceDelivery([native, terminal]).native[0].actions, [action]);
  assert.equal(terminalInputReceiptMatches([native], "k"), false);
  assert.equal(terminalInputReceiptMatches([terminal], "k"), false);
});

test("zero-based input trace sequence keeps the native report before its terminal request", { timeout: 5000 }, () => {
  const preedit = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: false };
  const native = { kind: "native-input", sequence: 0, cids: ["zero-based-cid"],
    input: { actions: [], preedit, errors: [] } };
  const terminal = { kind: "terminal-input", sequence: 1, cids: ["zero-based-cid"],
    input: { operation: "input", actions: [], preedit } };
  assert.deepEqual(assertInputTraceDelivery([native, terminal]).native.map((entry) => entry.sequence), [0]);
  assert.throws(() => inputTraceTransactions([{ ...native, sequence: -1 }]), /sequence must be a nonnegative safe integer/);
  assert.throws(() => inputTraceTransactions([{ ...native, sequence: 0.5 }]), /sequence must be a nonnegative safe integer/);
  assert.throws(() => inputTraceTransactions([{ ...native, sequence: Number.MAX_SAFE_INTEGER + 1 }]),
    /sequence must be a nonnegative safe integer/);
  assert.throws(() => assertInputTraceDelivery([native, { ...terminal, sequence: 0 }]),
    /input transaction 0 request preceded its native report/);
});

test("input transaction validation checks every action and correlation identifier", () => {
  const preedit = { text: "ㅏ", markedRange: { location: 0, length: 1 },
    selectedRange: { location: 1, length: 0 }, replacementRange: null, attributed: true };
  const valid = { kind: "native-input", sequence: 1, cids: ["input-cid-1"], input: { actions: [
    { type: "insert", text: "ㅏ", replacementRange: null, attributed: true },
  ], preedit, errors: [] } };
  const malformedTail = { ...valid, input: { ...valid.input, actions: [...valid.input.actions, { type: "unknown" }] } };
  assert.throws(() => terminalInputReceiptMatches([valid, malformedTail], "k"), /actions\[1\]\.type is unsupported/);
  const invalidFocusTail = { ...valid, input: { ...valid.input, actions: [...valid.input.actions,
    { type: "focus", focused: "yes" }] } };
  assert.throws(() => terminalInputReceiptMatches([valid, invalidFocusTail], "k"), /actions\[1\]\.focused must be boolean/);
  assert.throws(() => inputTraceTransactions([{ ...valid, cids: ["one", "two"] }]), /exactly one nonempty correlation/);
  assert.throws(() => inputTraceTransactions([{ ...valid, sequence: -1 }]), /sequence must be a nonnegative safe integer/);
  assert.throws(() => inputTraceTransactions([{ ...valid, input: { ...valid.input,
    preedit: { ...valid.input.preedit, markedRange: { location: 1, length: 1 } } } }]), /UTF-16 text bounds/);
  assert.throws(() => inputTraceTransactions([{ ...valid, input: { ...valid.input, actions: [
    { type: "key", key: "Char", text: null, shift: false, alt: false, ctrl: false },
  ] } }]), /actions\[0\]\.text must be text/);
  assert.throws(() => inputTraceTransactions([{ ...valid, input: { ...valid.input,
    actions: [{ type: "focus", focused: 1 }] } }]), /actions\[0\]\.focused must be boolean/);
  assert.throws(() => inputTraceTransactions([{ ...valid, input: { ...valid.input,
    errors: [{ reason: "native callback failed" }] } }]), /native input transaction failed: native callback failed/);
  assert.throws(() => inputTraceTransactions([{ kind: "native-insert", text: "ㅏ" }]), /obsolete native-insert/);
  assert.throws(() => inputTraceTransactions([{ kind: "other-input", input: {} }]), /unsupported kind "other-input"/);
});

test("native report and terminal request preserve actions, preedit and CID", () => {
  const preedit = { text: "", markedRange: null, selectedRange: { location: 0, length: 0 },
    replacementRange: null, attributed: false };
  const action = { type: "insert", text: " ", replacementRange: null, attributed: false };
  const native = { kind: "native-input", sequence: 4, cids: ["input-cid-9"], input: { actions: [action], preedit, errors: [] } };
  const terminal = { kind: "terminal-input", sequence: 5, cids: ["input-cid-9"], input: {
    operation: "input", actions: [action], preedit,
  } };
  assert.deepEqual(assertInputTraceDelivery([native, terminal]), {
    native: [{ cids: ["input-cid-9"], actions: [action], preedit, sequence: 4 }],
    terminal: [{ cids: ["input-cid-9"], actions: [action], preedit, sequence: 5 }],
  });
  assert.throws(() => assertInputTraceDelivery([native, { ...terminal, cids: ["different-cid"] }]),
    /input transaction 0 changed its correlation identifiers/);
  assert.throws(() => assertInputTraceDelivery([native, { ...terminal, sequence: native.sequence }]),
    /request preceded its native report/);
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

test("returns the latest coherent reread and its accepted event slice", { timeout: 5000 }, () => {
  const firstCompose = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const firstCursor = { row: 0, col: 8, focused: true, preedit: null };
  const currentCompose = { text: "ㅏ", markedRange: null, selectedRange: { location: 1, length: 0 },
    replacementRange: null, attributed: false };
  const currentCursor = { row: 0, col: 8, focused: true, preedit: { ...currentCompose } };
  const currentScreen = { ...screen([[cell("$"), cell(" ")]]), frame: { generation: 2, raster: 3, sequence: 5 } };
  const region = { frame: { x: 1, y: 2, width: 30, height: 20 },
    presented: { generation: 2, raster: 3, sequence: 5 } };
  const freshEvents = [
    { name: "terminal.compose", value: currentCompose },
    { name: "terminal.cursor", value: currentCursor },
  ];
  const snapshot = {
    compose: firstCompose,
    cursor: firstCursor,
    screen: currentScreen,
    region,
    currentCompose,
    currentCursor,
    stateEvents: freshEvents,
    coherence: { firstReadMatchesReread: false, cursorMatchesCompose: true, coherentReread: true,
      statusesMatch: true, baseScreenPresented: true },
  };

  assert.deepEqual(selectCoherentTerminalObservation(snapshot), {
    compose: currentCompose,
    cursor: currentCursor,
    screen: currentScreen,
    region,
    stateEvents: freshEvents,
  });
});

test("does not select a terminal observation before reread and presentation are coherent", { timeout: 5000 }, () => {
  const snapshot = { coherence: { coherentReread: false, baseScreenPresented: true }, stateEvents: [] };
  assert.throws(() => selectCoherentTerminalObservation(snapshot), /reread must be coherent/);
  assert.throws(() => selectCoherentTerminalObservation({ coherence: { coherentReread: true,
    baseScreenPresented: false }, stateEvents: [] }), /base screen must be presented/);
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


test("post-reference baseline accepts an unchanged prompt with fresh focus evidence", { timeout: 1500 }, () => {
  const empty = { text: "", markedRange: null, selectedRange: null, replacementRange: null, attributed: false };
  const rows = [[...Array.from("% ", (ch) => cell(ch)), cell(" ")]];
  const frame = { generation: 2, raster: 3, sequence: 4 };
  const cursor = { row: 0, col: 2, focused: true, preedit: null, frame, render: { frame } };
  const baseline = { compose: empty, cursor, screen: { ...screen(rows), frame } };
  const snapshot = { ...baseline, currentCompose: empty, currentCursor: cursor };
  const prompt = { row: 0, col: 0, text: "% " };
  const events = [{ name: "terminal.cursor", value: cursor }];
  assert.deepEqual(terminalInputBaselineAfterReference(baseline, prompt, snapshot, events).baseline, baseline);
  assert.equal(terminalObserverStatusesMatch(events, baseline, baseline), false,
    "per-key acceptance still requires a state change");
  assert.throws(() => terminalInputBaselineAfterReference(baseline, prompt, snapshot, []),
    /missing a matching status update/);
});


test("terminal observation reports a failed presentation read after successful status reads", { timeout: 1500 }, async () => {
  const hostError = new Error("presentation checkpoint unavailable");
  await assert.rejects(readTerminalObservationSnapshot({
    readCompose: async () => "compose",
    readCursor: async () => "cursor",
    readScreen: async () => "screen",
    readHost: async () => { throw hostError; },
  }), (error) => error instanceof AggregateError && error.errors.length === 1 &&
    error.errors[0].message === "host.window read failed" && error.errors[0].cause === hostError);
});


test("terminal observer stop releases each subscription once across repeated and concurrent calls", { timeout: 1500 }, async () => {
  const listeners = new Set();
  const released = [];
  const observer = await startTerminalStatusObserver({
    window: "main",
    client: { on(_name, listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    until: async () => ({ text: "" }),
    request: async (method, { name }) => { if (method === "status.unwatch") released.push(name); },
  }, "surface");
  await Promise.all([observer.stop(), observer.stop()]);
  await observer.stop();
  assert.deepEqual(released, ["terminal.screen", "terminal.cursor", "terminal.compose"]);
  assert.equal(listeners.size, 0);
});

test("terminal observer stop retries only subscriptions whose release did not succeed", { timeout: 1500 }, async () => {
  const released = [];
  let failCursor = true;
  const observer = await startTerminalStatusObserver({
    window: "main",
    client: { on() { return () => {}; } },
    until: async () => ({ text: "" }),
    request: async (method, { name }) => {
      if (method !== "status.unwatch") return;
      released.push(name);
      if (name === "terminal.cursor" && failCursor) {
        failCursor = false;
        throw new Error("cursor unwatch failed");
      }
    },
  }, "surface");
  await assert.rejects(observer.stop(), /cursor unwatch failed/);
  await observer.stop();
  assert.deepEqual(released, ["terminal.screen", "terminal.cursor", "terminal.cursor", "terminal.compose"]);
});
