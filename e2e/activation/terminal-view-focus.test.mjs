// Activation-tier comparison of identical native keys in a same-window AppKit control and terminal view.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "../fixture.mjs";
import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { presentedScreen, readScreenUntil, textLines } from "../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";
const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";
const COMMAND = "echo focuscheck";
const REPEATED_VOWEL_KEYS = ["k", "k", "k", "k"];
const REPEATED_VOWELS = "ㅏㅏㅏㅏ";
const INPUT_RECORDS = ["native.record.info", "native.input.key_down", "native.input.report", "host.input.relay",
  "host.window.event", "host.trace.region", "host.trace.sidecar.send", "page.call", "page.log.clock",
  "host.trace.sidecar.receive", "host.sidecar.request", "sidecar.vt.request", "sidecar.vt.pty_write", "sidecar.vt.pty_read"];

async function step(t, name, action) {
  const started = performance.now();
  console.log(`running ${name}`);
  try {
    const result = await action();
    console.log(`passed ${name} in ${(performance.now() - started).toFixed(1)}ms`);
    return result;
  } catch (error) {
    console.log(`failed ${name} in ${(performance.now() - started).toFixed(1)}ms: ${error.stack ?? error}`);
    throw error;
  }
}

async function typeCommand(s, requests = []) {
  const selected = await s.request("diagnostics.input.source", { select: ABC });
  assert.equal(selected.current, ABC, "ABC must be selected after focus");
  for (const key of [...COMMAND, "Enter"]) {
    const name = key === " " ? "Space" : key;
    for (const phase of ["down", "up"]) {
      const started = performance.now();
      const item = { key: name, phase, started, hostWindow: requests.hostWindow?.() };
      requests.push(item);
      try {
        await s.key(name, phase);
        item.acknowledged = performance.now();
      } catch (error) {
        item.failed = String(error);
        item.acknowledged = performance.now();
        throw error;
      }
    }
  }
}

function hostWindowFacts(value, surface) {
  return {
    active: value?.active,
    key: value?.key,
    responder: value?.responder,
    terminalFocused: value?.regions?.some((region) => region.surface === surface && region.name === "view" && region.focused),
  };
}

function cellIndexAtColumn(cells, target) {
  let column = 0;
  for (let index = 0; index < cells.length; index++) {
    const width = cells[index].width;
    assert.ok(Number.isInteger(width) && width >= 0,
      `terminal screen cell has invalid width: ${JSON.stringify(cells[index])}`);
    if (width === 0) continue;
    if (column === target) return index;
    assert.ok(target >= column + width || target <= column,
      `terminal cursor splits a wide screen cell: ${JSON.stringify({ target, column, cell: cells[index] })}`);
    column += width;
  }
  assert.equal(column, target, `terminal cursor column is outside the row: ${JSON.stringify({ target, column })}`);
  return cells.length;
}

function cellTextBetweenColumns(cells, start, end) {
  assert.ok(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start,
    `invalid terminal screen column range ${start}..${end}`);
  const first = cellIndexAtColumn(cells, start);
  const last = cellIndexAtColumn(cells, end);
  return cells.slice(first, last).map((cell) => cell.ch === undefined ? "" : cell.ch).join("");
}

function visibleInputBeforeCursor(screen, cursor, prompt, composeText = "") {
  assert.ok(Number.isInteger(cursor.row) && Number.isInteger(cursor.col),
    `terminal cursor has no cell position: ${JSON.stringify(cursor)}`);
  assert.ok(cursor.row >= prompt.row && cursor.row < screen.lines.length,
    `terminal cursor row is outside the screen: ${JSON.stringify({ cursor, rows: screen.lines.length })}`);
  const rows = [];
  for (let row = prompt.row; row <= cursor.row; row++) {
    const cells = screen.lines[row];
    const start = row === prompt.row ? prompt.col : 0;
    const end = row === cursor.row ? cursor.col : cells.reduce((columns, cell) => columns + cell.width, 0);
    rows.push(cellTextBetweenColumns(cells, start, end));
  }
  const committed = rows.join("");
  assert.ok(committed.startsWith(prompt.text),
    `terminal cursor prefix lost its initial shell prompt: ${JSON.stringify({ prompt, cursor, committed })}`);
  return `${committed.slice(prompt.text.length)}${composeText}`;
}

test("visible input preserves the prompt, handles wide cells, and ignores later blanks", () => {
  const screen = { lines: [
    [{ ch: "$", width: 1 }, { ch: " ", width: 1 }, { ch: undefined, width: 1 }],
    [{ ch: "界", width: 2 }, { ch: undefined, width: 0 }, { ch: undefined, width: 1 }],
    [{ ch: undefined, width: 10 }],
  ] };
  const prompt = { row: 0, col: 0, text: cellTextBetweenColumns(screen.lines[0], 0, 2) };
  assert.equal(visibleInputBeforeCursor(screen, { row: 0, col: 2 }, prompt, "ㅏ"), "ㅏ");
  assert.equal(visibleInputBeforeCursor(screen, { row: 1, col: 2 }, prompt, "ㅏ"), "界ㅏ");
  const mixed = { lines: [[{ ch: "$", width: 1 }, { ch: " ", width: 1 },
    { ch: "ㅏ", width: 1 }, { ch: "ㅏ", width: 1 }]] };
  const mixedPrompt = { row: 0, col: 0, text: "$ " };
  assert.equal(visibleInputBeforeCursor(mixed, { row: 0, col: 4 }, mixedPrompt, "ㅏ"), "ㅏㅏㅏ");
  assert.equal(visibleInputBeforeCursor(mixed, { row: 0, col: 4 }, mixedPrompt, ""), "ㅏㅏ");
});

test("sidecar screen facts preserve the numeric row count and frame cursor", () => {
  const facts = inputEventFacts([{
    event: "host.trace.sidecar.receive",
    ts_us: 1000,
    mono_ns: 125000,
    fields: {
      surface: "tab-ime",
      body: {
        event: "screen",
        sequence: 7,
        rows: 1,
        cols: 3,
        cells: [{ grapheme: "$", width: 1 }, { grapheme: " ", width: 1 }, { grapheme: "ㅏ", width: 1 }],
        frame: { generation: 3, raster: 3, sequence: 12 },
        cursor: { row: 0, col: 8, preedit: { text: "ㅏ" } },
      },
    },
  }], "tab-ime");
  assert.deepEqual(facts, [{
    at: 1,
    mono_ns: 125000,
    layer: "sidecar.screen",
    sequence: 7,
    rowCount: 1,
    frame: { generation: 3, raster: 3, sequence: 12 },
    cursor: { row: 0, col: 8, preedit: { text: "ㅏ" } },
    lines: ["$ ㅏ"],
  }]);
});

function frameMatches(left, right) {
  return left?.generation === right?.generation && left?.raster === right?.raster &&
    left?.sequence === right?.sequence;
}

function assertTerminalStageCoherent(stage, screenEvents, name) {
  assert.equal(stage.compose.text, stage.cursor.preedit?.text ?? "",
    `${name}: page composition and sidecar cursor preedit must agree`);
  const matchingFrames = screenEvents.filter((event) => frameMatches(event.frame, stage.frame));
  assert.ok(matchingFrames.length > 0,
    `${name}: no sidecar screen event names presented frame ${JSON.stringify(stage.frame)}`);
  assert.ok(matchingFrames.some((event) => event.rowCount === stage.rows.length &&
    event.cursor?.row === stage.cursor.row && event.cursor?.col === stage.cursor.col &&
    (event.cursor?.preedit?.text ?? "") === (stage.cursor.preedit?.text ?? "") &&
    JSON.stringify(event.lines) === JSON.stringify(stage.screen)),
  `${name}: sidecar screen rows and cursor do not match the presented frame`);
}

test("terminal stage requires matching screen, cursor, and compose state", () => {
  const stage = {
    frame: { generation: 2, raster: 4, sequence: 12 },
    rows: [{}, {}],
    screen: ["$ ㅏ", ""],
    cursor: { row: 0, col: 2, preedit: { text: "ㅏ" } },
    compose: { text: "ㅏ" },
  };
  const event = { rowCount: 2, frame: { ...stage.frame }, lines: stage.screen,
    cursor: { row: 0, col: 2, preedit: { text: "ㅏ" } } };
  assert.doesNotThrow(() => assertTerminalStageCoherent(stage, [event], "fixture"));
  assert.throws(() => assertTerminalStageCoherent(stage, [{ ...event, frame: { ...event.frame, sequence: 11 } }], "fixture"),
    /no sidecar screen event names presented frame/);
  assert.throws(() => assertTerminalStageCoherent(stage, [{ ...event, lines: ["$", ""] }], "fixture"),
    /screen rows and cursor do not match/);
  assert.throws(() => assertTerminalStageCoherent({ ...stage, compose: { text: "" } }, [event], "fixture"),
    /page composition and sidecar cursor preedit must agree/);
});

function inputEventFacts(events, surface) {
  const facts = [];
  for (const event of events) {
    const fields = event.fields ?? {};
    const at = event.ts_us / 1000;
    const cid = event.cids?.[0];
    if (event.event === "native.record.info" && fields.where === "input inject") {
      try {
        const input = JSON.parse(fields.text);
        if (input.kind === "key") facts.push({ at, layer: "native.inject", key: input.key, down: input.down,
          result: input.result, responder: input.responder, keyWindow: input.keyWindow });
      } catch { /* the host event remains available in the stored log */ }
    } else if (event.event === "native.input.key_down") {
      facts.push({ at, layer: "native.keyDown", key: fields.characters, cid,
        active: fields.before?.active, keyWindow: fields.before?.keyWindow, focus: fields.before?.focus });
    } else if (event.event === "native.input.report") {
      try {
        const report = JSON.parse(fields.report);
        if (report.type === "insert" || report.type === "key" || report.type === "focus") {
          facts.push({ at, layer: "native.report", type: report.type, key: report.text ?? report.key,
            cid, dropped: fields.dropped });
        }
      } catch { /* the host event remains available in the stored log */ }
    } else if (event.event === "host.input.relay" && fields.surface === surface) {
      facts.push({ at, layer: "host.relay", type: fields.type, key: fields.text ?? fields.key, cid });
    } else if (event.event === "host.trace.region" && fields.surface === surface) {
      const body = fields.body ?? {};
      if (body.type === "insert" || body.type === "key" || body.type === "focus") {
        facts.push({ at, layer: "host.region", type: body.type, key: body.text ?? body.key,
          cid: body.cids?.[0] });
      }
    } else if ((event.event === "plugin.terminal.ime" || event.event === "plugin.terminal.region") && fields.surface === surface) {
      if (fields.type === "insert" || fields.type === "key" || fields.type === "focus") {
        facts.push({ at, layer: event.event.endsWith(".ime") ? "plugin.ime" : "plugin.region",
          type: fields.type, key: fields.text ?? fields.key, cid: fields.cids?.[0] });
      }
    } else if ((event.event === "host.trace.sidecar.send" || event.event === "plugin.terminal.send") && fields.surface === surface) {
      const body = fields.body ?? {};
      if (body.operation === "input" && (body.bytes !== undefined || body.keys !== undefined)) {
        const bytes = body.bytes === undefined ? undefined : Buffer.from(body.bytes, "base64").toString("latin1");
        facts.push({ at, layer: "plugin.sidecarSend", bytes, keys: body.keys });
      }
    } else if (event.event === "sidecar.vt.pty_write" || event.event === "sidecar.vt.pty_read") {
      facts.push({ at, layer: event.event.endsWith("pty_write") ? "pty.write" : "pty.read",
        text: Buffer.from(fields.hex ?? "", "hex").toString("latin1"), sequence: fields.sequence });
    } else if (event.event === "host.window.event") {
      facts.push({ at, layer: "host.window.event", fields });
    } else if (event.event === "host.trace.sidecar.receive" && fields.surface === surface &&
      fields.body?.event === "screen") {
      const body = fields.body;
      facts.push({ at, mono_ns: event.mono_ns, layer: "sidecar.screen", sequence: body.sequence,
        frame: body.frame, cursor: body.cursor, rowCount: body.rows,
        lines: Array.from({ length: body.rows }, (_, row) => body.cells.slice(row * body.cols, (row + 1) * body.cols)
          .map((cell) => cell.grapheme === "" ? " ".repeat(cell.width) : cell.grapheme).join("").trimEnd()) });
    }
  }
  return facts;
}

async function observeInput(s, t, name, surface, action) {
  const offsets = currentEventOffsets(s.app.configDir);
  const statuses = [];
  const requests = [];
  const started = performance.now();
  const onStatus = (params) => {
    if (params?.window === s.window && params.name === "host.window") {
      statuses.push({ at: performance.now() - started, value: params.value });
    }
  };
  const off = s.client.on("status.changed", onStatus);
  await s.request("status.watch", { name: "host.window" });
  statuses.push({ at: performance.now() - started, value: await s.get("host.window"), initial: true });
  requests.hostWindow = () => statuses.at(-1)?.value;
  let failure;
  let result;
  try {
    result = await action(requests);
  } catch (error) {
    failure = error;
  } finally {
    off();
    await s.request("status.unwatch", { name: "host.window" });
    await s.flushLog();
    const { events } = readEvents(s.app.configDir, offsets);
    const inputEvents = inputEventFacts(events, surface);
    t.diagnostic(`${name} input observation: ${JSON.stringify({
      requests: requests.map(({ started: at, hostWindow, ...request }) => ({ at: at - started, ...request,
        hostWindow: hostWindowFacts(hostWindow, surface),
        acknowledged: request.acknowledged === undefined ? undefined : request.acknowledged - started })),
      hostWindowChanges: statuses.map(({ at, value, ...rest }) => ({ at, ...rest, ...hostWindowFacts(value, surface) })),
      inputEvents,
    })}`);
    if (result && typeof result === "object") result.inputEvents = inputEvents;
  }
  if (failure) throw failure;
  return result;
}

async function recordGesture(s, t, name, action) {
  const capture = await s.record();
  let actionResult;
  let actionError;
  try {
    actionResult = await action();
  } catch (error) {
    actionError = error;
  }
  let result;
  let captureError;
  try {
    const { displayed } = await s.presented();
    result = await capture.stop({ after: displayed + 100 });
  } catch (error) {
    captureError = error;
  }
  if (actionError && captureError) throw new AggregateError([actionError, captureError], `${name}: action and capture stop failed`);
  if (captureError) throw captureError;
  let captureValidationError;
  try {
    const framePaths = frames(capture.frames);
    const frameNames = framePaths.map((framePath) => basename(framePath));
    const decoded = framePaths.map(readFrame);
    assert.equal(decoded.length, result.count, `${name}: every captured frame must decode`);
    assert.ok(decoded.length >= 2, `${name}: the recording must cover the full gesture`);
    assert.equal(result.limited, false, `${name}: capture reached its limit`);
    assert.equal(result.callbackStatus, join(capture.frames, "callback-status.jsonl"), `${name}: stop must name the callback trace`);
    const callbackTrace = readFileSync(result.callbackStatus, "utf8");
    assert.notEqual(callbackTrace.trim(), "", `${name}: the callback trace must not be empty`);
    const callbackStatus = callbackTrace.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(callbackStatus.length <= 4096, `${name}: callback trace exceeded its declared bound`);
    for (const [index, callback] of callbackStatus.entries()) {
    assert.equal(callback.sequence, index + 1, `${name}: callback sequence must be contiguous`);
    assert.ok(callback.status === null || Number.isInteger(callback.status), `${name}: status must be an integer or null`);
    assert.ok(callback.displayTime === null || (typeof callback.displayTime === "string" && /^\d+$/.test(callback.displayTime)),
      `${name}: displayTime must be exact decimal mach time or null`);
    for (const field of ["callbackTime", "writeStartTime", "writeCompleteTime"]) {
      assert.ok(typeof callback[field] === "string" && /^\d+$/.test(callback[field]),
        `${name}: ${field} must be an exact decimal mach time`);
    }
    assert.ok(BigInt(callback.callbackTime) <= BigInt(callback.writeStartTime)
      && BigInt(callback.writeStartTime) <= BigInt(callback.writeCompleteTime),
    `${name}: raw callback and processing times must be ordered`);
    assert.ok(Number.isSafeInteger(callback.machTimebaseNumerator) && callback.machTimebaseNumerator > 0
      && Number.isSafeInteger(callback.machTimebaseDenominator) && callback.machTimebaseDenominator > 0,
    `${name}: mach timebase values must be positive integers`);
    assert.equal(callback.machTimebaseNumerator, callbackStatus[0].machTimebaseNumerator,
      `${name}: mach timebase numerator must remain stable during the capture`);
    assert.equal(callback.machTimebaseDenominator, callbackStatus[0].machTimebaseDenominator,
      `${name}: mach timebase denominator must remain stable during the capture`);
    assert.ok(callback.frame === null || typeof callback.frame === "string",
      `${name}: frame must name an emitted file or be null`);
    if (callback.frame !== null) {
      assert.equal(callback.status, 0, `${name}: only complete callbacks may identify a frame`);
      assert.ok(typeof callback.displayTime === "string" && /^\d+$/.test(callback.displayTime),
        `${name}: a recorded frame callback must have an exact display time`);
      assert.ok(frameNames.includes(callback.frame), `${name}: callback names a frame that was not recorded: ${callback.frame}`);
    }
    }
    const frameCallbacks = callbackStatus.flatMap((callback, index) => callback.frame === null ? [] : [{ callback, index }]);
    assert.deepEqual(frameCallbacks.map(({ callback }) => callback.frame), frameNames,
    `${name}: callback frame filenames must match the recorded files one-to-one and in order`);
    assert.equal(frameCallbacks.length, decoded.length, `${name}: every decoded frame must have exactly one callback`);
    const gaps = decoded.slice(1).map((frame, index) => ({
    from: frameNames[index], to: frameNames[index + 1], milliseconds: frame.time - decoded[index].time,
    callbacks: callbackStatus.slice(frameCallbacks[index].index + 1, frameCallbacks[index + 1].index)
      .map(({ sequence, status, displayTime, frame: emittedFrame }) => ({ sequence, status, displayTime, frame: emittedFrame })),
    }));
    const rawDifference = (later, earlier) => (BigInt(later) - BigInt(earlier)).toString();
    const callbackTiming = frameCallbacks.map(({ callback }) => ({
    sequence: callback.sequence,
    frame: callback.frame,
    arrivalAfterDisplayRaw: rawDifference(callback.callbackTime, callback.displayTime),
    synchronousProcessingRaw: rawDifference(callback.writeCompleteTime, callback.writeStartTime),
    }));
    t.diagnostic(`${name} callback arrival/synchronous-processing deltas: ${JSON.stringify({
    timebase: { numerator: callbackStatus[0].machTimebaseNumerator, denominator: callbackStatus[0].machTimebaseDenominator },
    frames: callbackTiming,
    })}`);
    const missedBound = gaps.filter((gap) => gap.milliseconds > 33);
    const overBoundTiming = missedBound.map((gap) => {
    const index = frameNames.indexOf(gap.from);
    const from = frameCallbacks[index].callback;
    const to = frameCallbacks[index + 1].callback;
    return {
      from: gap.from,
      to: gap.to,
      decodedMilliseconds: gap.milliseconds,
      displayDeltaRaw: rawDifference(to.displayTime, from.displayTime),
      arrivalDeltaRaw: rawDifference(to.callbackTime, from.callbackTime),
      fromArrivalAfterDisplayRaw: rawDifference(from.callbackTime, from.displayTime),
      toArrivalAfterDisplayRaw: rawDifference(to.callbackTime, to.displayTime),
      fromProcessingRaw: rawDifference(from.writeCompleteTime, from.writeStartTime),
      toProcessingRaw: rawDifference(to.writeCompleteTime, to.writeStartTime),
      timebase: { numerator: from.machTimebaseNumerator, denominator: from.machTimebaseDenominator },
    };
    });
    const statusCounts = callbackStatus.reduce((counts, { status }) => {
    const key = status === null ? "missing" : String(status);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
    }, {});
    const noFrameCounts = callbackStatus.filter(({ frame: emittedFrame }) => emittedFrame === null)
      .reduce((counts, { status }) => {
      const key = status === null ? "missing" : String(status);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
      }, {});
    t.diagnostic(`${name} callback trace: ${JSON.stringify({ callbacks: callbackStatus.length, statusCounts, noFrameCounts,
      over33ms: missedBound, overBoundTiming })}`);
    const measuredLongestGap = Math.max(...gaps.map(({ milliseconds }) => milliseconds));
    assert.ok(result.longestGap <= 33, `${name}: frame gap ${result.longestGap}ms exceeds 33ms`);
    assert.ok(measuredLongestGap <= 33, `${name}: decoded frame gap ${measuredLongestGap}ms exceeds 33ms`);
    t.diagnostic(`${name}: ${JSON.stringify({ frames: result.count, longestGap: result.longestGap })}`);
  } catch (error) {
    captureValidationError = error;
  }
  if (actionError && captureValidationError) {
    throw new AggregateError([actionError, captureValidationError], `${name}: action and capture validation failed`);
  }
  if (captureValidationError) throw captureValidationError;
  if (actionError) throw actionError;
  return actionResult;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a terminal click accepts the same native keys as its AppKit reference`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const terminal = await step(t, `${app.name}: prepare terminal`, () => fresh(s, {
      performanceTrace: true, log: EVERY_LEVEL,
      reads: INPUT_RECORDS,
    }));
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("$")), "shell prompt missing");
    await s.keepPointerOutside();
    const originalSource = (await s.request("diagnostics.input.source")).current;
    s.cleanup(() => s.request("diagnostics.input.source", { select: originalSource }));
    assert.deepEqual(await s.request("diagnostics.input.reference", { action: "read" }), { open: false },
      "the disposable configuration must not contain an open reference");
    await s.request("diagnostics.input.reference", { action: "open" });
    let referenceOpen = true;
    s.cleanup(async () => {
      if (referenceOpen) await s.request("diagnostics.input.reference", { action: "close" });
    });
    await step(t, `${app.name}: reference focus and identical keys`, () => recordGesture(s, t, "AppKit reference", () => observeInput(s, t, "AppKit reference", surface, async (requests) => {
      const reference = await s.request("diagnostics.input.reference", { action: "read" });
      assert.equal(reference.document, "", "the independent reference must start empty");
      await s.pointer(reference.frame.x + reference.frame.w / 2, reference.frame.y + reference.frame.h / 2,
        "move", { activate: true });
      const focused = await s.request("diagnostics.input.reference", { action: "focus" });
      assert.equal(focused.focused, true, "the AppKit reference must receive native focus");
      await typeCommand(s, requests);
      const document = await s.request("diagnostics.input.reference", { action: "wait", document: `${COMMAND}\n` });
      assert.equal(document.document, `${COMMAND}\n`, "the reference must receive the exact native key sequence");
      assert.equal(document.marked, null, "the reference must finish without marked text");
      assert.equal(document.focused, true, "the reference must retain native focus during typing");
      t.diagnostic(`AppKit reference: ${JSON.stringify(document)}`);
    })));
    await s.request("diagnostics.input.reference", { action: "close" });
    referenceOpen = false;
    assert.deepEqual(await s.request("diagnostics.input.reference", { action: "read" }), { open: false });
    await s.presented();
    const trace = await s.get("terminal.pointer.trace", surface);
    assert.equal(trace.enabled, false, "terminal pointer trace must start idle");
    await s.run("terminal.pointer.trace", { action: "start" }, surface);
    let tracing = true;
    s.cleanup(async () => {
      if (tracing) await s.run("terminal.pointer.trace", { action: "stop" }, surface);
    });
    await step(t, `${app.name}: terminal click and identical keys`, () => recordGesture(s, t, "terminal", () => observeInput(s, t, "terminal", surface, async (requests) => {
      const current = (await s.get("core.surfaces")).find((item) => item.surface === surface);
      assert.ok(current?.visible && current.composition === "view" && current.applied,
        "the terminal must expose its current applied native frame");
      const { x, y, w, h } = current.applied;
      await s.click(x + w / 2, y + h / 2);
      const host = await s.until("host.window", (value) => value.active && value.key &&
        value.regions.some((region) => region.surface === surface && region.name === "view" && region.focused),
      "the clicked terminal did not receive native focus in the active key window");
      assert.equal(host.responder?.surface, surface, "the first responder must belong to the clicked terminal");
      await typeCommand(s, requests);
      const lines = await readScreenUntil(s, surface, (rows) => rows.includes("focuscheck"),
        "the terminal did not execute the same native key sequence as its AppKit reference");
      assert.equal(lines.filter((row) => row === "focuscheck").length, 1, "the typed command output must occur once");
      assert.equal((await s.get("terminal.session", surface)).error, undefined, "native typing must not report a session error");
      const after = await s.get("host.window");
      assert.equal(after.responder?.surface, surface, "the terminal must retain its first responder after typing");
      t.diagnostic(`terminal: ${JSON.stringify({ surface, applied: current.applied, responder: after.responder, lines })}`);
    })));
    tracing = false;
    const input = await s.run("terminal.pointer.trace", { action: "stop" }, surface);
    assert.equal(input.overflow, false, "the terminal pointer trace must not lose events");
    for (const type of ["pointerdown", "pointerup"]) assert.ok(input.entries.some((entry) =>
      entry.kind === "pointer-dom" && entry.type === type && entry.trusted), `the native click delivered no trusted ${type}`);
    t.diagnostic(`terminal pointer trace: ${JSON.stringify(input)}`);
  });

  test(`${app.name}: repeated Korean vowels stay visible before Space`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const terminal = await step(t, `${app.name}: prepare repeated-vowel terminal`, () => fresh(s, {
      performanceTrace: true,
      log: EVERY_LEVEL,
      reads: INPUT_RECORDS,
    }));
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("$")), "shell prompt missing");
    await s.keepPointerOutside();
    const originalSource = (await s.request("diagnostics.input.source")).current;
    s.cleanup(() => s.request("diagnostics.input.source", { select: originalSource }));
    assert.deepEqual(await s.request("diagnostics.input.reference", { action: "read" }), { open: false },
      "the disposable configuration must not contain an open reference");
    await s.request("diagnostics.input.reference", { action: "open" });
    let referenceOpen = true;
    s.cleanup(async () => {
      if (referenceOpen) await s.request("diagnostics.input.reference", { action: "close" });
    });

    const referenceStages = [];
    await step(t, `${app.name}: AppKit reference repeated-vowel gesture`, () => recordGesture(s, t,
      "AppKit repeated-vowel reference", () => observeInput(s, t, "AppKit repeated-vowel reference", surface,
        async () => {
          const reference = await s.request("diagnostics.input.reference", { action: "read" });
          assert.equal(reference.document, "", "the AppKit reference must start empty");
          await s.pointer(reference.frame.x + reference.frame.w / 2, reference.frame.y + reference.frame.h / 2,
            "move", { activate: true });
          const focused = await s.request("diagnostics.input.reference", { action: "focus" });
          assert.equal(focused.focused, true, "the AppKit reference must receive native focus");
          assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET,
            "Korean 2-set must be selected for the reference");
          for (const [index, key] of REPEATED_VOWEL_KEYS.entries()) {
            await s.press(key);
            await s.presented();
            const stage = await s.request("diagnostics.input.reference", { action: "read" });
            referenceStages.push(stage);
            assert.equal(stage.document, REPEATED_VOWELS.slice(0, index + 1),
              `the AppKit reference document after vowel ${index + 1} must match the native key sequence`);
            t.diagnostic(`${app.name}: AppKit reference after vowel ${index + 1}: ${JSON.stringify(stage)}`);
          }
          await s.press("Space");
          const committed = await s.request("diagnostics.input.reference", {
            action: "wait", document: `${REPEATED_VOWELS} `,
          });
          assert.equal(committed.document, `${REPEATED_VOWELS} `,
            "the AppKit reference must commit the four vowels and Space exactly");
          assert.equal(committed.marked, null, "the AppKit reference must finish without marked text");
          t.diagnostic(`${app.name}: AppKit reference committed result: ${JSON.stringify(committed)}`);
        })));
    await s.request("diagnostics.input.reference", { action: "close" });
    referenceOpen = false;
    assert.deepEqual(await s.request("diagnostics.input.reference", { action: "read" }), { open: false });

    let imeTracing = false;
    const terminalResult = await step(t, `${app.name}: terminal focus and repeated-vowel gesture`, () =>
      observeInput(s, t, "terminal repeated-vowel gesture", surface, async () => {
          const current = (await s.get("core.surfaces")).find((item) => item.surface === surface);
          assert.ok(current?.visible && current.composition === "view" && current.applied,
            "the terminal must expose its current applied native frame");
          const { x, y, w, h } = current.applied;
          await s.click(x + w / 2, y + h / 2);
          const host = await s.until("host.window", (value) => value.active && value.key &&
            value.regions.some((region) => region.surface === surface && region.name === "view" && region.focused),
          "the clicked terminal did not receive native focus in the active key window");
          assert.equal(host.responder?.surface, surface, "the first responder must belong to the clicked terminal");
          assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET,
            "Korean 2-set must be selected for the terminal");
          const initialScreen = await presentedScreen(s, surface);
          const initialCursor = await s.get("terminal.cursor", surface);
          const promptText = cellTextBetweenColumns(initialScreen.rows[initialCursor.row], 0, initialCursor.col);
          assert.ok(promptText.trimEnd().endsWith("$"),
            `the terminal cursor must start at its shell prompt: ${JSON.stringify({ promptText, initialCursor })}`);
          const prompt = { row: initialCursor.row, col: 0, text: promptText };
          const idleTrace = await s.get("terminal.ime.trace", surface);
          assert.equal(idleTrace.enabled, false, "the terminal IME trace must start idle");
          await s.run("terminal.ime.trace", { action: "start" }, surface);
          assert.equal((await s.get("terminal.ime.trace", surface)).enabled, true,
            "the terminal IME trace must start before native input");
          imeTracing = true;
          s.cleanup(async () => {
            if (imeTracing) {
              imeTracing = false;
              const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
              t.diagnostic(`${app.name}: retained terminal IME trace after failure: ${JSON.stringify(trace)}`);
            }
          });

          const gesture = await step(t, `${app.name}: record terminal repeated-vowel keys`, () =>
            recordGesture(s, t, "terminal repeated-vowel keys", async () => {
          const terminalStages = [];
          for (const [index, key] of REPEATED_VOWEL_KEYS.entries()) {
            await s.press(key);
            const screen = await presentedScreen(s, surface);
            const cursor = await s.get("terminal.cursor", surface);
            const compose = await s.get("terminal.compose", surface);
            const stage = {
              index: index + 1,
              key,
              reference: referenceStages[index],
              frame: screen.frame,
              rows: screen.rows,
              screen: textLines({ lines: screen.rows }),
              cursor,
              compose,
            };
            terminalStages.push(stage);
            t.diagnostic(`${app.name}: terminal before Space after vowel ${index + 1}: ${JSON.stringify({
              index: stage.index,
              key: stage.key,
              referenceDocument: stage.reference.document,
              frame: stage.frame,
              screen: stage.screen,
              cursor: stage.cursor,
              compose: stage.compose,
            })}`);
          }

          const beforeSpace = terminalStages.at(-1).cursor;
          await s.press("Space");
          const committedLines = await readScreenUntil(s, surface,
            (lines) => lines.some((line) => line.includes(REPEATED_VOWELS)),
            "the terminal did not display all four vowels before another key");
          const afterSpace = await s.until("terminal.cursor", (cursor) => cursor.row > beforeSpace.row ||
            cursor.col > beforeSpace.col, "Space did not advance the terminal PTY cursor", { surface });
          const committedCompose = await s.get("terminal.compose", surface);
          imeTracing = false;
          const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
          const sessionError = (await s.get("terminal.session", surface)).error;
          const nativeInserts = trace.entries.filter((entry) => entry.kind === "native-insert")
            .map((entry) => entry.text).join("");
          const ptyInserts = trace.entries.filter((entry) => entry.kind === "terminal-input" &&
            entry.input.type === "insert").map((entry) => entry.input.text).join("");
          const stageInput = terminalStages.map(({ rows, cursor, compose }) =>
            visibleInputBeforeCursor({ lines: rows }, cursor, prompt, compose.text));
          return { terminalStages, stageInput, committedLines, afterSpace, committedCompose,
            nativeInserts, ptyInserts, trace, sessionError };
            }));
          return gesture;
      }));
    const screenEvents = terminalResult.inputEvents.filter((event) => event.layer === "sidecar.screen");
    for (const stage of terminalResult.terminalStages) {
      assertTerminalStageCoherent(stage, screenEvents, `${app.name}: vowel ${stage.index}`);
    }
    writeFileSync(join(s.app.configDir, "terminal-ime-stage-observations.json"), JSON.stringify({
      referenceStages,
      terminalStages: terminalResult.terminalStages,
      screenEvents,
      stageInput: terminalResult.stageInput,
      committedLines: terminalResult.committedLines,
      afterSpace: terminalResult.afterSpace,
      committedCompose: terminalResult.committedCompose,
      nativeInserts: terminalResult.nativeInserts,
      ptyInserts: terminalResult.ptyInserts,
      trace: terminalResult.trace.entries,
    }, null, 2));
    assert.equal(terminalResult.trace.overflow, false, "the terminal IME trace must not overflow");
    assert.equal(terminalResult.committedCompose.text, "",
      "Space must end the terminal preedit before another key");
    const occurrences = terminalResult.committedLines.reduce((count, line) =>
      count + line.split(REPEATED_VOWELS).length - 1, 0);
    assert.equal(occurrences, 1, "the terminal must display the committed vowels exactly once");
    assert.equal((await s.get("terminal.session", surface)).error, undefined,
      "the native repeated-vowel input must not report a session error");
    assert.equal(terminalResult.nativeInserts, `${REPEATED_VOWELS} `,
      "the native input client must commit the four reference vowels and Space exactly");
    assert.equal(terminalResult.ptyInserts, `${REPEATED_VOWELS} `,
      "the terminal PTY input queue must receive the four vowels and Space exactly");
    assert.equal(terminalResult.sessionError, undefined,
      "the native repeated-vowel input must not report a session error");
    assert.deepEqual(terminalResult.stageInput,
      referenceStages.map(({ document }) => document),
      "terminal cell text plus its separate composition must match the AppKit stages before Space");
    t.diagnostic(`${app.name}: repeated-vowel terminal result ${JSON.stringify({
      stages: terminalResult.terminalStages.map(({ index, key, reference, frame, screen, cursor, compose }) => ({
        index, key, reference: reference.document, frame, screen, cursor, compose,
      })),
      screenEvents,
      committedLines: terminalResult.committedLines,
      afterSpace: terminalResult.afterSpace,
      committedCompose: terminalResult.committedCompose,
      nativeInserts: terminalResult.nativeInserts,
      ptyInserts: terminalResult.ptyInserts,
      trace: terminalResult.trace.entries,
    })}`);
  });
}
