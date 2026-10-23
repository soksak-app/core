// Activation-tier comparison of identical native keys in a same-window AppKit control and terminal view.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "../fixture.mjs";
import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { readScreenUntil } from "../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";
const COMMAND = "echo focuscheck";
const INPUT_RECORDS = ["native.record.info", "native.input.key_down", "native.input.report", "host.input.relay",
  "host.window.event", "host.trace.region", "host.trace.sidecar.send", "page.call", "page.log.clock",
  "host.sidecar.request", "sidecar.vt.request", "sidecar.vt.pty_write", "sidecar.vt.pty_read"];

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
  try {
    await action(requests);
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
  }
  if (failure) throw failure;
}

async function recordGesture(s, t, name, action) {
  const capture = await s.record();
  await action();
  const { displayed } = await s.presented();
  const result = await capture.stop({ after: displayed + 100 });
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
}
