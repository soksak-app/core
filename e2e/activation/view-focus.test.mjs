// Compares identical native keys in a same-window AppKit control and the image region of a raster probe view
// (e2e/raster-probe.mjs). The AppKit reference takes characters only through the OS input method, and the second check composes
// Korean through it; the input method serves only the key window of the active application
// (docs/spec/exposure.md#virtual-key-window), so this check activates the application and selects the input source. The probe
// logs each input transaction of its region with the body that its fixture sidecar received (rasterprobe.input), so the check
// compares the committed text and the preedit that reached the region and the sidecar with the reference document.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { APPS, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh, joinedFailure } from "../fixture.mjs";
import { EVERY_LEVEL } from "@soksak/window-check/log-policy.mjs";
import { addRasterTab, REGION } from "../raster-probe.mjs";
import { activateApplication } from "./image-focus.mjs";

const COMMAND = "echo focuscheck";
const REPEATED_VOWEL_KEYS = ["k", "k", "k", "k"];
const REPEATED_VOWELS = "ㅏㅏㅏㅏ";
const INPUT_RECORDS = ["native.record.info", "native.input.key_down", "native.input.report", "host.input.relay",
  "host.window.event", "host.trace.region", "host.trace.sidecar.send", "workbench.call", "workbench.log.clock",
  "host.trace.sidecar.receive", "host.sidecar.request", "sidecar.rasterprobe.request"];

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
  const selected = await s.request("diagnostics.input.source", { select: "latin" });
  assert.equal(selected.current, "latin", "the latin input source must be selected after focus");
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
    regionFocused: value?.regions?.some((region) => region.surface === surface && region.name === REGION && region.focused),
  };
}

/**
 * The document that the ordered actions of input transactions type, as an AppKit text view holds it: committed inserts and
 * character keys add their text, Enter and insertNewline: add a line break, Space adds a space and a focus change adds nothing.
 * Any other action is written as a bracketed marker, so it makes the document differ from every reference document.
 */
function typedText(actions) {
  return actions.map((action) => {
    if (action.type === "focus") return "";
    if (action.type === "insert") return action.text;
    if (action.type === "key" && action.key === "Char") return action.text;
    if ((action.type === "key" && action.key === "Enter") || (action.type === "command" && action.selector === "insertNewline:")) return "\n";
    if (action.type === "key" && action.key === "Space") return " ";
    return `[${JSON.stringify(action)}]`;
  }).join("");
}

/** The committed inserts of the ordered actions, without key or command actions. */
function insertedText(actions) {
  return actions.filter((action) => action.type === "insert").map((action) => action.text).join("");
}

/** The document of the image region: the text that its logged transactions committed followed by its current preedit. */
function regionDocument(input) {
  return `${typedText(input.log.flatMap((entry) => entry.actions))}${input.preedit?.text ?? ""}`;
}

/**
 * Waits until the fixture sidecar received every logged transaction of the image region since `baseline` (the transaction count
 * before the gesture), and checks that the log lost none of them, that each received body repeats the transaction exactly and
 * that no transaction carried a callback error. Returns the input status.
 */
async function assertDelivered(s, surface, baseline, name) {
  const input = await s.until("rasterprobe.input", (value) => value.log.length > 0 && value.log.every((entry) => entry.received !== null),
    `${name}: the raster probe sidecar did not receive every input transaction`, { surface });
  assert.equal(input.log.length, input.transactions - baseline, `${name}: the raster probe input log lost transactions`);
  assert.deepEqual(input.log.map((entry) => entry.sequence),
    Array.from({ length: input.log.length }, (_, index) => baseline + index + 1), `${name}: the input transactions are not contiguous`);
  for (const entry of input.log) {
    assert.deepEqual(entry.received, { operation: "input", sequence: entry.sequence, actions: entry.actions, preedit: entry.preedit },
      `${name}: the sidecar received a different body for input transaction ${entry.sequence}`);
    assert.deepEqual(entry.errors, [], `${name}: input transaction ${entry.sequence} carried callback errors`);
  }
  return input;
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
      if (body.type === "insert" || body.type === "key" || body.type === "focus" || body.type === "input") {
        facts.push({ at, layer: "host.region", type: body.type, key: body.text ?? body.key, actions: body.actions,
          preedit: body.preedit, cid: body.cids?.[0] });
      }
    } else if (event.event === "host.trace.sidecar.send" && fields.surface === surface) {
      const body = fields.body ?? {};
      if (body.operation === "input") facts.push({ at, layer: "host.sidecarSend", sequence: body.sequence, actions: body.actions });
    } else if (event.event === "sidecar.rasterprobe.request") {
      facts.push({ at, layer: "sidecar.request", operation: fields.operation, bytes: fields.bytes, cid });
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
  let presentError;
  try {
    const { displayed } = await s.presented();
    // The recording is the evidence of the gesture: its counts are told, and the check does not judge it.
    result = await capture.stop({ after: displayed + 100 });
  } catch (error) {
    presentError = error;
  }
  if (actionError && presentError) throw joinedFailure(`${name}: action and presentation failed`, [actionError, presentError]);
  if (presentError) throw presentError;
  t.diagnostic(`${name}: ${recordingSummary(result)}`);
  if (actionError) throw actionError;
  return actionResult;
}

/**
 * Checks the stages of the image region before Space against the AppKit reference: each stage holds the document of the
 * reference after the same vowel key, and its committed text plus its preedit equals that document.
 */
function assertImageRegionStages(stages, referenceStages, name) {
  assert.equal(stages.length, referenceStages.length, `${name}: the image region has no stage for every reference stage`);
  for (const [index, stage] of stages.entries()) {
    assert.equal(`${stage.committed}${stage.preedit}`, referenceStages[index].document,
      `${name}: the committed text and preedit of the image region after vowel ${index + 1} differ from the AppKit reference`);
  }
}

async function openReference(s) {
  await s.keepPointerOutside();
  const originalSource = (await s.request("diagnostics.input.source")).source;
  s.cleanup(() => s.request("diagnostics.input.source", { restore: originalSource }));
  assert.deepEqual(await s.request("diagnostics.input.reference", { action: "read" }), { open: false },
    "the disposable configuration must not contain an open reference");
  await s.request("diagnostics.input.reference", { action: "open" });
  const reference = { open: true };
  s.cleanup(async () => {
    if (reference.open) await s.request("diagnostics.input.reference", { action: "close" });
  });
  return reference;
}

async function closeReference(s, reference) {
  await s.request("diagnostics.input.reference", { action: "close" });
  reference.open = false;
  assert.deepEqual(await s.request("diagnostics.input.reference", { action: "read" }), { open: false });
}

/** Clicks the center of the applied frame of the raster probe view and waits until its image region holds native focus. */
async function clickRegion(s, surface) {
  const current = (await s.get("core.surfaces")).find((item) => item.surface === surface);
  assert.ok(current?.visible && current.composition === "view" && current.applied,
    "the raster probe view must expose its current applied native frame");
  const { x, y, w, h } = current.applied;
  await s.click(x + w / 2, y + h / 2);
  const host = await s.until("host.window", (value) => value.active && value.key &&
    value.regions.some((region) => region.surface === surface && region.name === REGION && region.focused),
  "the clicked image region did not receive native focus in the active key window");
  assert.equal(host.responder?.surface, surface, "the first responder must belong to the clicked raster probe view");
  return current;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: an image region click accepts the same native keys as its AppKit reference`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await step(t, `${app.name}: prepare the raster probe`, () => fresh(s, {
      performanceTrace: true, log: EVERY_LEVEL,
      reads: INPUT_RECORDS,
    }));
    const { surface } = await addRasterTab(s);
    const reference = await openReference(s);
    await step(t, `${app.name}: reference focus and identical keys`, () => recordGesture(s, t, "AppKit reference", () => observeInput(s, t, "AppKit reference", surface, async (requests) => {
      const read = await s.request("diagnostics.input.reference", { action: "read" });
      assert.equal(read.document, "", "the independent reference must start empty");
      await activateApplication(s);
      await s.pointer(read.frame.x + read.frame.w / 2, read.frame.y + read.frame.h / 2,
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
    await closeReference(s, reference);
    await s.presented();
    // The input log and the pointer list of the probe start empty, so every entry after this belongs to the click and the keys.
    await s.run("rasterprobe.input.clear", {}, surface);
    const baseline = (await s.get("rasterprobe.input", surface)).transactions;
    await step(t, `${app.name}: image region click and identical keys`, () => recordGesture(s, t, "image region", () => observeInput(s, t, "image region", surface, async (requests) => {
      const current = await clickRegion(s, surface);
      await typeCommand(s, requests);
      const typed = await s.until("rasterprobe.input", (value) => regionDocument(value) === `${COMMAND}\n`,
        "the image region did not receive the same native key sequence as its AppKit reference", { surface });
      assert.equal(typed.preedit?.text ?? "", "", "the image region must finish without preedit");
      const input = await assertDelivered(s, surface, baseline, "image region");
      assert.equal(typedText(input.log.flatMap((entry) => entry.actions)), `${COMMAND}\n`,
        "the sidecar must receive the typed command exactly once");
      assert.equal((await s.get("rasterprobe.session", surface)).error, null, "native typing must not report a view error");
      const after = await s.get("host.window");
      assert.equal(after.responder?.surface, surface, "the raster probe view must retain its first responder after typing");
      t.diagnostic(`image region: ${JSON.stringify({ surface, applied: current.applied, responder: after.responder, log: input.log })}`);
    })));
    const input = await s.until("rasterprobe.input", (value) => value.pointer.some((event) => event.type === "pointerup"),
      "the raster probe view logged no pointerup of the click", { surface });
    assert.ok(input.pointer.length < 64, "the raster probe pointer list must not lose events");
    for (const type of ["pointerdown", "pointerup"]) assert.ok(input.pointer.some((event) => event.type === type && event.trusted),
      `the native click delivered no trusted ${type}`);
    t.diagnostic(`raster probe pointer list: ${JSON.stringify(input.pointer)}`);
  });

  test(`${app.name}: repeated Korean vowels stay in the image region preedit before Space`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await step(t, `${app.name}: prepare the repeated-vowel raster probe`, () => fresh(s, {
      performanceTrace: true,
      log: EVERY_LEVEL,
      reads: INPUT_RECORDS,
    }));
    const { surface } = await addRasterTab(s);
    const reference = await openReference(s);

    const referenceStages = [];
    await step(t, `${app.name}: AppKit reference repeated-vowel gesture`, () => recordGesture(s, t,
      "AppKit repeated-vowel reference", () => observeInput(s, t, "AppKit repeated-vowel reference", surface,
        async () => {
          const read = await s.request("diagnostics.input.reference", { action: "read" });
          assert.equal(read.document, "", "the AppKit reference must start empty");
          await activateApplication(s);
          await s.pointer(read.frame.x + read.frame.w / 2, read.frame.y + read.frame.h / 2,
            "move", { activate: true });
          const focused = await s.request("diagnostics.input.reference", { action: "focus" });
          assert.equal(focused.focused, true, "the AppKit reference must receive native focus");
          assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean",
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
    await closeReference(s, reference);
    await s.run("rasterprobe.input.clear", {}, surface);
    const baseline = (await s.get("rasterprobe.input", surface)).transactions;

    const result = await step(t, `${app.name}: image region focus and repeated-vowel gesture`, () =>
      observeInput(s, t, "image region repeated-vowel gesture", surface, async () => {
        await clickRegion(s, surface);
        assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean",
          "Korean 2-set must be selected for the image region");
        const initial = await s.get("rasterprobe.input", surface);
        assert.equal(regionDocument(initial), "", `the image region must start without text: ${JSON.stringify(initial)}`);
        return step(t, `${app.name}: record image region repeated-vowel keys`, () =>
          recordGesture(s, t, "image region repeated-vowel keys", async () => {
            const stages = [];
            for (const [index, key] of REPEATED_VOWEL_KEYS.entries()) {
              await s.press(key);
              const expected = referenceStages[index].document;
              const input = await s.until("rasterprobe.input", (value) => regionDocument(value) === expected,
                `${app.name}: the image region did not hold the AppKit document after vowel ${index + 1}`, { surface });
              const stage = { index: index + 1, key, reference: expected,
                committed: typedText(input.log.flatMap((entry) => entry.actions)), preedit: input.preedit?.text ?? "" };
              stages.push(stage);
              writeFileSync(join(s.app.configDir, "image-region-ime-stage-observations.json"), JSON.stringify({
                referenceStages, stages,
              }, null, 2));
              t.diagnostic(`${app.name}: image region before Space after vowel ${index + 1}: ${JSON.stringify(stage)}`);
            }
            await s.press("Space");
            const committed = await s.until("rasterprobe.input", (value) => regionDocument(value) === `${REPEATED_VOWELS} ` &&
              (value.preedit?.text ?? "") === "",
            `${app.name}: Space did not commit the four vowels in the image region`, { surface });
            const input = await assertDelivered(s, surface, baseline, `${app.name}: repeated vowels`);
            const actions = input.log.flatMap((entry) => entry.actions);
            const received = input.log.flatMap((entry) => entry.received.actions);
            return { stages, committedPreedit: committed.preedit, nativeInserts: insertedText(actions),
              sidecarInserts: insertedText(received), log: input.log };
          }));
      }));
    writeFileSync(join(s.app.configDir, "image-region-ime-stage-observations.json"), JSON.stringify({
      referenceStages,
      stages: result.stages,
      committedPreedit: result.committedPreedit,
      nativeInserts: result.nativeInserts,
      sidecarInserts: result.sidecarInserts,
      log: result.log,
    }, null, 2));
    assertImageRegionStages(result.stages, referenceStages, app.name);
    assert.equal(result.committedPreedit?.text ?? "", "", "Space must end the image region preedit before another key");
    assert.equal(result.nativeInserts, `${REPEATED_VOWELS} `,
      "the native input client must commit the four reference vowels and Space exactly");
    assert.equal(result.sidecarInserts, `${REPEATED_VOWELS} `,
      "the raster probe sidecar must receive the four vowels and Space exactly");
    assert.equal((await s.get("rasterprobe.session", surface)).error, null,
      "the native repeated-vowel input must not report a view error");
    t.diagnostic(`${app.name}: repeated-vowel image region result ${JSON.stringify({
      stages: result.stages,
      committedPreedit: result.committedPreedit,
      nativeInserts: result.nativeInserts,
      sidecarInserts: result.sidecarInserts,
      log: result.log,
    })}`);
  });
}
