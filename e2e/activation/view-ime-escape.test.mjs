// Checks that Escape during a composition of the macOS Korean input method in a focused image region ends the composition as it
// does in a same-window AppKit reference, without forwarding a workbench command. The image region is that of the raster probe,
// whose `rasterprobe.input` logs each input transaction of the native input client of core with the frame that its sidecar drew after
// it: the region presents the frame of each stage, and each native input transaction that the event log records reaches the sidecar
// unchanged under its correlation identifiers. The subject is the composition of the OS
// input method, which serves only the key window of the active application, so this check activates the application and
// selects the input source of the person.
import assert from "node:assert/strict";
import test from "node:test";

import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { compareAppKitReference } from "./ime-reference-steps.mjs";
import { assertReceivedUnchanged, inputDocument, lastTransaction, presentedStage, rasterProbeTab, receivedAfter,
  untilDocument } from "../input-probe.mjs";
import { focusImageActive } from "./image-focus.mjs";
import { NATIVE_INPUT_LOG, NATIVE_INPUT_READS, nativeInputDelivered, nativeInputStart } from "../native-input-trace.mjs";

const REGISTRY_COMMAND = "workbench.command";
const MODAL_ANSWER = "workbench.trace.modal.answer";
const PICKER_CLOSE = "workbench.trace.picker.close";
const INPUT_INJECTION = "native.record.info";
const READS = [REGISTRY_COMMAND, MODAL_ANSWER, PICKER_CLOSE, "workbench.input.shortcut.failed", INPUT_INJECTION,
  "native.input.key_down", ...NATIVE_INPUT_READS];

async function openProbe(t, app) {
  const s = await open(t, app);
  await fresh(s, { performanceTrace: true, log: { ...NATIVE_INPUT_LOG, lifecycle: "info", call: "debug" }, reads: READS });
  await keepCommonSettings(s);
  s.cleanup(async () => {
    if ((await s.get("core.modal"))?.id === "settings") await s.run("core.settings.close");
    if ((await s.get("core.picker")).open) await s.run("core.picker.close");
    if ((await s.get("core.screen")).screen === "library") {
      await s.run("core.library.page", { page: "projects" });
      await s.run("core.library.return");
    }
  });
  return s;
}

async function traceEvents(s, offsets) {
  await s.flushLog();
  return readEvents(s.app.configDir, offsets).events;
}

function traceCommands(events, name) {
  return events.filter((event) => event.event === REGISTRY_COMMAND && event.fields?.name === name);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: IME Escape ends view composition as it does in AppKit`, { timeout: 90000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await rasterProbeTab(s);
    await focusImageActive(s, surface);
    await s.selectInputSource("korean");
    await compareAppKitReference(s, ["g", "k", "s", "Escape"], "한", ["ㅎ", "하", "한", "한"]);
    await focusImageActive(s, surface);
    const inputOffsets = nativeInputStart(s);
    const start = await lastTransaction(s, surface);
    const recording = await s.record();
    // The recording starts before the first key and remains active through the committed document after Escape.
    for (const [key, expected] of [["g", "ㅎ"], ["k", "하"], ["s", "한"]]) {
      await s.press(key);
      await s.until("rasterprobe.input", (input) => input.preedit?.text === expected,
        `the Korean input method did not produce ${expected}`, { surface });
      await presentedStage(s, surface, `the preedit ${expected}`);
    }
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("Escape");
    await s.until("rasterprobe.input", (input) => input.preedit?.text === "", "Escape did not end the active composition", { surface });
    await untilDocument(s, surface, start, "한", "Escape did not commit the AppKit reference text into the region document");
    await presentedStage(s, surface, "the commit of Escape");
    const log = await receivedAfter(s, surface, start, "the sidecar did not echo the input transactions");
    assertReceivedUnchanged(log, `${app.name} IME Escape`);
    await nativeInputDelivered(s, surface, inputOffsets, start, `${app.name} IME Escape`);
    assert.equal(inputDocument(log), "한", `the region document does not end in the committed AppKit text: ${JSON.stringify(log)}`);
    const gestureEnd = await s.presented();
    const stopped = await recording.stop({ after: gestureEnd.displayed + 100 });
    const events = await traceEvents(s, offsets);
    assert.equal(traceCommands(events, "core.picker.close").length, 0,
      "composition Escape must not forward core.picker.close");
    assert.equal(events.filter((event) => event.event === "workbench.input.shortcut.failed").length, 0,
      "composition Escape must not forward a workbench shortcut command");
    assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
    t.diagnostic(`${app.name}: recorded the g/k/s/Escape gesture in ${stopped.count} frames, ${stopped.missed} missed ` +
      `and ${stopped.late} late stills`);
  });
}
