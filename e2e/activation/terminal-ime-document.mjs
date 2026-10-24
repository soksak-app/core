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
