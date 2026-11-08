// Checks that Escape during a composition of the macOS Korean input method in a focused image region ends the composition as it
// does in a same-window AppKit reference, without forwarding a workbench command. The image region is that of the raster probe,
// whose `rasterprobe.input` logs each input transaction of the native input client of core. The subject is the composition of the OS
// input method, which serves only the key window of the active application, so this check activates the application and
// selects the input source of the person.
import assert from "node:assert/strict";
import test from "node:test";

import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "../fixture.mjs";
import { compareAppKitReference } from "./ime-reference-steps.mjs";
import { assertReceivedUnchanged, inputDocument, lastTransaction, rasterProbeTab, receivedAfter,
  untilDocument } from "../input-probe.mjs";
import { focusImageActive } from "./image-focus.mjs";

const REGISTRY_COMMAND = "workbench.command";
const MODAL_ANSWER = "workbench.trace.modal.answer";
const PICKER_CLOSE = "workbench.trace.picker.close";
const INPUT_INJECTION = "native.record.info";
const READS = [REGISTRY_COMMAND, MODAL_ANSWER, PICKER_CLOSE, "workbench.input.shortcut.failed", INPUT_INJECTION,
  "native.input.key_down"];

async function openProbe(t, app) {
  const s = await open(t, app);
  await fresh(s, { performanceTrace: true, log: { input: "info", lifecycle: "info", call: "debug" }, reads: READS });
  await keepCommonSettings(s);
  s.cleanup(async () => {
    if ((await s.get("host.window")).modal?.id === "settings") await s.run("core.settings.close");
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
    const start = await lastTransaction(s, surface);
    const recording = await s.record();
    // The recording starts before the first key and remains active through the committed document after Escape.
    for (const [key, expected] of [["g", "ㅎ"], ["k", "하"], ["s", "한"]]) {
      await s.press(key);
      await s.until("rasterprobe.input", (input) => input.preedit?.text === expected,
        `the Korean input method did not produce ${expected}`, { surface });
    }
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("Escape");
    await s.until("rasterprobe.input", (input) => input.preedit?.text === "", "Escape did not end the active composition", { surface });
    await untilDocument(s, surface, start, "한", "Escape did not commit the AppKit reference text into the region document");
    const log = await receivedAfter(s, surface, start, "the sidecar did not echo the input transactions");
    assertReceivedUnchanged(log, `${app.name} IME Escape`);
    assert.equal(inputDocument(log), "한", `the region document does not end in the committed AppKit text: ${JSON.stringify(log)}`);
    const gestureEnd = await s.presented();
    const stopped = await recording.stop({ after: gestureEnd.displayed + 100 });
    const captured = frames(recording.frames).map(readFrame);
    assert.equal(captured.length, stopped.count, "the IME Escape recording has missing frame files");
    assert.ok(captured.length > 1, "the IME Escape recording has no complete frames");
    assert.equal(stopped.limited, false, "the IME Escape recording exceeded its bounded capacity");
    const events = await traceEvents(s, offsets);
    assert.equal(traceCommands(events, "core.picker.close").length, 0,
      "composition Escape must not forward core.picker.close");
    assert.equal(events.filter((event) => event.event === "workbench.input.shortcut.failed").length, 0,
      "composition Escape must not forward a workbench shortcut command");
    assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
    t.diagnostic(`${app.name}: captured complete g/k/s/Escape gesture in ${captured.length} frames`);
  });
}
