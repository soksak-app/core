import assert from "node:assert/strict";

function rangeState(value, label, required = false) {
  if (value === undefined && !required) return null;
  if (value === null) return null;
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be a range or null`);
  assert.ok(Number.isSafeInteger(value.location) && value.location >= 0,
    `${label}.location must be a nonnegative integer`);
  assert.ok(Number.isSafeInteger(value.length) && value.length >= 0,
    `${label}.length must be a nonnegative integer`);
  return { location: value.location, length: value.length };
}

function compositionFields(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.ok(typeof value.text === "string", `${label}.text must be a string`);
  assert.ok(typeof value.attributed === "boolean", `${label}.attributed must be a boolean`);
  assert.ok(Object.hasOwn(value, "markedRange"), `${label}.markedRange is required`);
  const markedRange = rangeState(value.markedRange, `${label}.markedRange`, true);
  const selectedRange = rangeState(value.selectedRange, `${label}.selectedRange`);
  const replacementRange = rangeState(value.replacementRange, `${label}.replacementRange`);
  return { text: value.text, markedRange, selectedRange, replacementRange, attributed: value.attributed };
}

function preeditState(value) {
  if (value === undefined || value === null) return { kind: "none" };
  return { kind: "present", ...compositionFields(value, "cursor.preedit") };
}

/** Returns only terminal state that determines the input-method composition. */
export function terminalCompositionState(compose, cursor) {
  assert.ok(cursor && typeof cursor === "object" && !Array.isArray(cursor), "terminal cursor must be an object");
  assert.ok(Number.isInteger(cursor.row) && cursor.row >= 0, "terminal cursor.row must be a nonnegative integer");
  assert.ok(Number.isInteger(cursor.col) && cursor.col >= 0, "terminal cursor.col must be a nonnegative integer");
  assert.ok(typeof cursor.focused === "boolean", "terminal cursor.focused must be a boolean");
  return {
    compose: compositionFields(compose, "terminal.compose"),
    cursor: {
      row: cursor.row,
      col: cursor.col,
      focused: cursor.focused,
      preedit: preeditState(cursor.preedit),
    },
  };
}

export function sameTerminalComposition(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Reports whether a coherent terminal sample completed the corresponding reference document. */
export function terminalStageMatchesReference(snapshot, expectedDocument) {
  assert.ok(snapshot && typeof snapshot === "object", "terminal stage snapshot must be an object");
  assert.equal(typeof snapshot.coherent, "boolean", "terminal stage coherence must be boolean");
  if (snapshot.coherent) assert.equal(typeof snapshot.document, "string", "coherent terminal stage document must be text");
  assert.equal(typeof expectedDocument, "string", "AppKit reference document must be text");
  return snapshot.coherent && snapshot.document === expectedDocument;
}

/** Waits for a coherent terminal document to match the same-key AppKit reference. */
export async function waitForTerminalStage(events, read, waitForEvent, expectedDocument, label, timeoutMs = 1500) {
  assert.ok(Array.isArray(events), "terminal stage events must be an array");
  assert.equal(typeof read, "function", "terminal stage reread must be a function");
  assert.equal(typeof waitForEvent, "function", "terminal stage event wait must be a function");
  assert.equal(typeof expectedDocument, "string", "AppKit reference document must be text");
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "terminal stage timeout must be positive");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const eventOffset = events.length;
    const snapshot = await read();
    const remaining = deadline - Date.now();
    if (remaining < 0) {
      throw new Error(`${label}: terminal document did not reach its AppKit reference within ${timeoutMs} ms`);
    }
    if (terminalStageMatchesReference(snapshot, expectedDocument)) return snapshot;
    if (remaining <= 0) {
      throw new Error(`${label}: terminal document did not reach its AppKit reference within ${timeoutMs} ms`);
    }
    await waitForEvent(eventOffset, remaining);
  }
}

export function terminalComposeMatchesPreedit(compose, cursor) {
  const current = compositionFields(compose, "terminal.compose");
  if (cursor?.preedit === undefined || cursor?.preedit === null) {
    const emptySelection = current.selectedRange === null ||
      (current.selectedRange.location === 0 && current.selectedRange.length === 0);
    return current.text === "" && current.markedRange === null && emptySelection &&
      current.replacementRange === null && current.attributed === false;
  }
  return sameTerminalComposition(current, compositionFields(cursor.preedit, "cursor.preedit"));
}

/** Checks one fresh status update against the known pre-key state and the current coherent reads. */
export function terminalObserverStatusesMatch(currentEvents, baseline, current) {
  assert.ok(Array.isArray(currentEvents), "terminal observer events must be an array");
  assertScreenCursor(baseline.screen, baseline.cursor, "terminal baseline");
  assertScreenCursor(current.screen, current.cursor, "terminal current screen");
  const latestComposeEvent = currentEvents.findLast((event) => event.name === "terminal.compose");
  const latestCursorEvent = currentEvents.findLast((event) => event.name === "terminal.cursor");
  const latestScreenEvent = currentEvents.findLast((event) => event.name === "terminal.screen");
  const latestCompose = latestComposeEvent?.value;
  const latestCursor = latestCursorEvent?.value;
  const latestScreen = latestScreenEvent?.value;
  if (latestComposeEvent) compositionFields(latestCompose, "terminal.compose notification");
  if (latestCursorEvent) terminalCompositionState(current.compose, latestCursor);
  if (latestScreenEvent) assert.ok(Array.isArray(latestScreen), "terminal.screen notification must be raw cell rows");
  const baselineState = terminalCompositionState(baseline.compose, baseline.cursor);
  const currentState = terminalCompositionState(current.compose, current.cursor);
  const compositionChanged = !sameTerminalComposition(baselineState, currentState);
  const rowsChanged = JSON.stringify(baseline.screen.rows) !== JSON.stringify(current.screen.rows);

  if (currentEvents.length === 0 || (!compositionChanged && !rowsChanged)) return false;
  if (!baseline.cursor.focused || !current.cursor.focused) return false;
  if (!terminalComposeMatchesPreedit(current.compose, current.cursor)) return false;
  if (latestComposeEvent && !sameTerminalComposition(
    terminalCompositionState(latestCompose, current.cursor), currentState)) return false;
  if (latestCursorEvent && !sameTerminalComposition(
    terminalCompositionState(current.compose, latestCursor), currentState)) return false;
  if (!latestComposeEvent && !latestCursorEvent && !latestScreenEvent && !sameTerminalComposition(
    terminalCompositionState(baseline.compose, current.cursor), currentState)) return false;
  if (!latestCursorEvent && (baseline.cursor.row !== current.cursor.row || baseline.cursor.col !== current.cursor.col ||
    baseline.cursor.focused !== current.cursor.focused)) return false;

  if (latestScreenEvent) {
    return JSON.stringify(latestScreen) === JSON.stringify(current.screen.rows);
  }
  const before = baseline.screen;
  const after = current.screen;
  return !rowsChanged && before.frame?.generation === after.frame?.generation &&
    before.frame?.raster === after.frame?.raster &&
    Number.isInteger(before.frame?.sequence) && Number.isInteger(after.frame?.sequence) &&
    after.frame.sequence >= before.frame.sequence;
}

function exactObject(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unexpected fields`);
}

function strictRange(value, label) {
  if (value === null) return null;
  exactObject(value, ["location", "length"], label);
  assert.ok(Number.isSafeInteger(value.location) && value.location >= 0, `${label}.location is invalid`);
  assert.ok(Number.isSafeInteger(value.length) && value.length >= 0, `${label}.length is invalid`);
  assert.ok(Number.isSafeInteger(value.location + value.length), `${label} exceeds the safe integer range`);
  return value;
}

function strictPreedit(value, label) {
  exactObject(value, ["text", "markedRange", "selectedRange", "replacementRange", "attributed"], label);
  assert.equal(typeof value.text, "string", `${label}.text must be text`);
  assert.equal(typeof value.attributed, "boolean", `${label}.attributed must be boolean`);
  for (const key of ["markedRange", "selectedRange", "replacementRange"]) strictRange(value[key], `${label}.${key}`);
  for (const key of ["markedRange", "selectedRange"]) {
    const range = value[key];
    if (range !== null) assert.ok(range.location + range.length <= value.text.length,
      `${label}.${key} exceeds the UTF-16 text bounds`);
  }
  return value;
}

function strictAction(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  if (value.type === "insert") {
    exactObject(value, ["type", "text", "replacementRange", "attributed"], label);
    assert.equal(typeof value.text, "string", `${label}.text must be text`);
    strictRange(value.replacementRange, `${label}.replacementRange`);
    assert.equal(typeof value.attributed, "boolean", `${label}.attributed must be boolean`);
    return value;
  }
  if (value.type === "key") {
    assert.equal(typeof value.key, "string", `${label}.key must be text`);
    assert.ok(value.key.length > 0, `${label}.key must not be empty`);
    const fields = value.key === "Char" ? ["type", "key", "text", "shift", "alt", "ctrl"] :
      ["type", "key", "shift", "alt", "ctrl"];
    exactObject(value, fields, label);
    if (value.key === "Char") assert.equal(typeof value.text, "string", `${label}.text must be text`);
    for (const modifier of ["shift", "alt", "ctrl"]) {
      assert.equal(typeof value[modifier], "boolean", `${label}.${modifier} must be boolean`);
    }
    return value;
  }
  if (value.type === "command") {
    exactObject(value, ["type", "selector"], label);
    assert.equal(typeof value.selector, "string", `${label}.selector must be text`);
    assert.ok(value.selector.length > 0, `${label}.selector must not be empty`);
    return value;
  }
  if (value.type === "focus") {
    exactObject(value, ["type", "focused"], label);
    assert.equal(typeof value.focused, "boolean", `${label}.focused must be boolean`);
    return value;
  }
  throw new Error(`${label}.type is unsupported: ${JSON.stringify(value.type)}`);
}

function strictCids(value, label) {
  assert.ok(Array.isArray(value) && value.length === 1 && typeof value[0] === "string" && value[0].length > 0,
    `${label} must contain exactly one nonempty correlation identifier`);
  return value;
}

function strictActions(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((action, index) => strictAction(action, `${label}[${index}]`));
}

function strictTraceSequence(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

/** Parses every current input transaction in a trace, validating trailing records before a caller accepts a match. */
export function inputTraceTransactions(entries) {
  assert.ok(Array.isArray(entries), "terminal IME trace entries must be an array");
  const native = [];
  const terminal = [];
  for (const [index, entry] of entries.entries()) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `trace entry ${index} must be an object`);
    if (["native-insert", "native-key", "native-compose"].includes(entry.kind)) {
      throw new Error(`trace entry ${index} uses obsolete ${entry.kind}; expected native-input`);
    }
    if (entry.kind === "native-input") {
      exactObject(entry.input, ["actions", "preedit", "errors"], `native-input ${index}.input`);
      const sequence = strictTraceSequence(entry.sequence, `native-input ${index}.sequence`);
      const cids = strictCids(entry.cids, `native-input ${index}.cids`);
      const actions = strictActions(entry.input.actions, `native-input ${index}.actions`);
      const preedit = strictPreedit(entry.input.preedit, `native-input ${index}.preedit`);
      assert.ok(Array.isArray(entry.input.errors), `native-input ${index}.errors must be an array`);
      for (const [errorIndex, error] of entry.input.errors.entries()) {
        exactObject(error, ["reason"], `native-input ${index}.errors[${errorIndex}]`);
        assert.equal(typeof error.reason, "string", `native-input ${index}.errors[${errorIndex}].reason must be text`);
        assert.ok(error.reason.length > 0, `native-input ${index}.errors[${errorIndex}].reason must not be empty`);
      }
      assert.equal(entry.input.errors.length, 0,
        `native input transaction failed: ${entry.input.errors.map(({ reason }) => reason).join("; ")}`);
      native.push({ cids, actions, preedit, sequence });
      continue;
    }
    if (entry.kind === "terminal-input") {
      exactObject(entry.input, ["operation", "actions", "preedit"], `terminal-input ${index}.input`);
      assert.equal(entry.input.operation, "input", `terminal-input ${index}.input.operation must be input`);
      const sequence = strictTraceSequence(entry.sequence, `terminal-input ${index}.sequence`);
      const cids = strictCids(entry.cids, `terminal-input ${index}.cids`);
      const actions = strictActions(entry.input.actions, `terminal-input ${index}.actions`);
      const preedit = strictPreedit(entry.input.preedit, `terminal-input ${index}.preedit`);
      terminal.push({ cids, actions, preedit, sequence });
      continue;
    }
    throw new Error(`trace entry ${index} has unsupported kind ${JSON.stringify(entry.kind)}`);
  }
  return { native, terminal };
}

/** Verifies that every successful native transaction reached the VT request unchanged with the same CID. */
export function assertInputTraceDelivery(entries) {
  const { native, terminal } = inputTraceTransactions(entries);
  assert.equal(terminal.length, native.length,
    `trace has ${native.length} native input reports and ${terminal.length} terminal input requests`);
  for (const [index, transaction] of native.entries()) {
    const request = terminal[index];
    assert.deepEqual(request.cids, transaction.cids, `input transaction ${index} changed its correlation identifiers`);
    assert.ok(request.sequence > transaction.sequence, `input transaction ${index} request preceded its native report`);
    assert.deepEqual(request.actions, transaction.actions, `input transaction ${index} changed actions before the VT request`);
    assert.deepEqual(request.preedit, transaction.preedit, `input transaction ${index} changed preedit before the VT request`);
  }
  return { native, terminal };
}

function transactionMatchesKey(transaction, key) {
  if (key === "k") {
    const keyAction = transaction.actions.some((action) =>
      (action.type === "key" && action.key === "Char" && action.text === key) ||
      (action.type === "insert" && action.text.length > 0));
    return keyAction || (transaction.actions.length === 0 && transaction.preedit.text.length > 0);
  }
  if (key === "Backspace") {
    return transaction.actions.some((action) => (action.type === "key" && action.key === key) ||
      (action.type === "command" && action.selector === "deleteBackward:"));
  }
  if (key === "Space") {
    return transaction.actions.some((action) => (action.type === "key" && (action.key === key ||
      (action.key === "Char" && action.text.includes(" ")))) ||
      (action.type === "insert" && action.text.includes(" ")));
  }
  throw new Error(`terminal IME trace has no receipt rule for key ${JSON.stringify(key)}`);
}

/** Reports whether a current native or terminal transaction acknowledges the key just sent. */
export function terminalInputReceiptMatches(entries, key) {
  assert.ok(["k", "Backspace", "Space"].includes(key),
    `terminal IME trace has no receipt rule for key ${JSON.stringify(key)}`);
  const transactions = inputTraceTransactions(entries);
  return [...transactions.native, ...transactions.terminal].some((transaction) => transactionMatchesKey(transaction, key));
}

const TERMINAL_INPUT_STATUSES = ["terminal.compose", "terminal.cursor", "terminal.screen"];

/** Resolves after a status event newer than the caller's sample offset arrives. */
export function waitForStateEvent(events, after, subscribe, label, timeoutMs = 1500) {
  if (events.length > after) return Promise.resolve(events.at(-1));
  return new Promise((resolve, reject) => {
    let settled = false;
    let off = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${label}: no later terminal status notification`)), timeoutMs);
    off = subscribe(() => {
      if (events.length > after) finish(resolve, events.at(-1));
    });
    // A notification may arrive while the subscription is being installed.
    if (events.length > after) finish(resolve, events.at(-1));
  });
}

/** Resolves only for a matching status event on the caller's existing observer stream. */
export function waitForObservedStatusEvent(events, after, subscribe, name, predicate, label, timeoutMs = 1500) {
  assert.ok(Array.isArray(events), "terminal observer events must be an array");
  assert.ok(Number.isInteger(after) && after >= 0, "terminal observer event offset must be nonnegative");
  assert.equal(typeof predicate, "function", "terminal observer predicate must be a function");
  const matchingEvent = () => events.slice(after).findLast((event) => event.name === name && predicate(event.value));
  const current = matchingEvent();
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    let settled = false;
    let off = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      callback(value);
    };
    const timer = setTimeout(() => finish(reject,
      new Error(`${label}: no matching ${name} notification on the existing observer stream`)), timeoutMs);
    off = subscribe(() => {
      const event = matchingEvent();
      if (event) finish(resolve, event);
    });
    const arrivedDuringSubscribe = matchingEvent();
    if (arrivedDuringSubscribe) finish(resolve, arrivedDuringSubscribe);
  });
}

/** Starts the status event stream used to observe terminal input. */
export async function startTerminalStatusObserver(session, surface, onEvent = () => {}) {
  await session.until("terminal.compose", (compose) => compose?.text === "",
    "the terminal started with a nonempty preedit", { surface });
  const events = [];
  const names = new Set(TERMINAL_INPUT_STATUSES);
  const off = session.client.on("status.changed", (params) => {
    if (params?.window !== session.window || params?.surface !== surface || !names.has(params?.name)) return;
    const event = { at: performance.now(), name: params.name, value: params.value };
    events.push(event);
    onEvent(event);
  });
  const watched = [];
  try {
    for (const name of TERMINAL_INPUT_STATUSES) {
      await session.request("status.watch", { name, surface });
      watched.push(name);
    }
  } catch (error) {
    off();
    for (const name of watched.reverse()) await session.request("status.unwatch", { name, surface });
    throw error;
  }
  return {
    events,
    async stop() {
      off();
      for (const name of [...watched].reverse()) await session.request("status.unwatch", { name, surface });
    },
  };
}

function assertScreenCursor(screen, cursor, label) {
  assert.ok(screen && Array.isArray(screen.rows), `${label}: terminal.screen.read rows are missing`);
  assert.ok(screen.frame && Number.isInteger(screen.frame.generation) && Number.isInteger(screen.frame.raster)
    && Number.isInteger(screen.frame.sequence), `${label}: terminal.screen.read frame is invalid`);
  assert.ok(Number.isInteger(cursor?.row) && Number.isInteger(cursor?.col), `${label}: terminal cursor is invalid`);
  assert.ok(cursor.row >= 0 && cursor.row < screen.rows.length, `${label}: terminal cursor row is out of bounds`);
}

function appendCellRange(cells, start, end, label) {
  let column = 0;
  let text = "";
  for (const cell of cells) {
    assert.ok(Number.isInteger(cell.width) && cell.width >= 0, `${label}: terminal cell width is invalid`);
    const next = column + cell.width;
    if (next <= start) {
      column = next;
      continue;
    }
    if (column >= end) break;
    assert.ok(column >= start && next <= end,
      `${label}: requested range splits a display cell at column ${column}`);
    text += cell.ch === undefined ? " ".repeat(cell.width) : cell.ch;
    column += cell.width;
  }
  assert.ok(column >= end, `${label}: requested range extends beyond its screen row`);
  return text;
}

export function terminalLineBeforeCursor(screen, cursor, label = "terminal screen") {
  assertScreenCursor(screen, cursor, label);
  const cells = screen.rows[cursor.row];
  assert.ok(Array.isArray(cells), `${label}: terminal cursor row ${cursor.row} is missing`);
  return appendCellRange(cells, 0, cursor.col, label);
}

export function visibleInputBeforeCursor(screen, cursor, prompt, preedit, label = "terminal input") {
  assertScreenCursor(screen, cursor, label);
  assert.ok(Number.isInteger(prompt?.row) && Number.isInteger(prompt?.col) && typeof prompt?.text === "string",
    `${label}: terminal prompt position is invalid`);
  assert.ok(prompt.row >= 0 && prompt.row <= cursor.row, `${label}: terminal prompt row is after the cursor`);
  let committed = "";
  for (let row = prompt.row; row <= cursor.row; row++) {
    const cells = screen.rows[row];
    assert.ok(Array.isArray(cells), `${label}: terminal row ${row} is missing`);
    const totalWidth = cells.reduce((width, cell) => {
      assert.ok(Number.isInteger(cell.width) && cell.width >= 0, `${label}: terminal cell width is invalid`);
      return width + cell.width;
    }, 0);
    const start = row === prompt.row ? prompt.col : 0;
    const end = row === cursor.row ? cursor.col : totalWidth;
    committed += appendCellRange(cells, start, end, label);
  }
  assert.ok(committed.startsWith(prompt.text),
    `${label}: committed prompt prefix changed: ${JSON.stringify(committed)}`);
  return committed.slice(prompt.text.length) + preedit;
}

function rowText(rows) {
  return rows.map((row) => row.map((cell) => cell.ch === undefined ? " ".repeat(cell.width) : cell.ch)
    .join("").trimEnd());
}

function assertCompositionRanges(current, expected, label) {
  for (const field of ["markedRange", "selectedRange"]) {
    assert.deepEqual(current?.[field] ?? null, expected?.[field] ?? null, `${label}: ${field} differs`);
  }
}

export function assertTerminalStageCoherent({ screen, region, compose, cursor, stateEvents }, label = "terminal stage") {
  assert.ok(region?.presented, `${label}: terminal image region has no presented frame`);
  assert.equal(region.presented.generation, screen.frame.generation, `${label}: presented frame generation differs`);
  assert.equal(region.presented.raster, screen.frame.raster, `${label}: presented frame raster differs`);
  assert.ok(region.presented.sequence >= screen.frame.sequence,
    `${label}: region has not presented the base screen frame`);
  assert.equal(cursor?.preedit?.text ?? "", compose.text, `${label}: cursor preedit differs from compose`);
  assertCompositionRanges(cursor?.preedit, compose, `${label}: cursor preedit`);
  const last = (name) => stateEvents.findLast((event) => event.name === name)?.value;
  const composeEvent = last("terminal.compose");
  if (composeEvent) {
    assert.equal(composeEvent.text, compose.text, `${label}: latest compose notification is stale`);
    assertCompositionRanges(composeEvent, compose, `${label}: latest compose notification`);
  }
  const cursorEvent = last("terminal.cursor");
  if (cursorEvent) {
    assert.equal(cursorEvent.row, cursor.row, `${label}: latest cursor notification row is stale`);
    assert.equal(cursorEvent.col, cursor.col, `${label}: latest cursor notification column is stale`);
    assert.equal(cursorEvent.preedit?.text ?? "", cursor.preedit?.text ?? "",
      `${label}: latest cursor notification preedit is stale`);
    assertCompositionRanges(cursorEvent.preedit, cursor.preedit, `${label}: latest cursor notification`);
  }
  const screenEvent = last("terminal.screen");
  if (screenEvent) {
    assert.ok(Array.isArray(screenEvent), `${label}: terminal.screen notification is not a raw cell rows array`);
    assert.equal(screenEvent.length, screen.rows.length, `${label}: latest screen notification row count differs`);
    assert.deepEqual(rowText(screenEvent), rowText(screen.rows),
      `${label}: screen notification differs from terminal.screen.read`);
  }
}

/** Selects the accepted read set after the observer finds a coherent reread. */
export function selectCoherentTerminalObservation(snapshot) {
  assert.ok(snapshot && typeof snapshot === "object", "terminal observation snapshot must be an object");
  assert.equal(snapshot.coherence?.coherentReread, true, "terminal observation reread must be coherent");
  assert.equal(snapshot.coherence?.baseScreenPresented, true, "terminal observation base screen must be presented");
  assert.ok(Array.isArray(snapshot.stateEvents), "terminal observation events must be an array");
  return {
    compose: snapshot.currentCompose,
    cursor: snapshot.currentCursor,
    screen: snapshot.screen,
    region: snapshot.region,
    stateEvents: snapshot.stateEvents,
  };
}
