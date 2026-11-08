// Checks that Escape during a composition of the macOS Korean input method in a focused terminal view ends the composition as
// it does in a same-window AppKit reference, without forwarding a workbench command. The subject is the composition of the OS
// input method, which serves only the key window of the active application, so this check activates the application and
// selects the input source of the person.
import assert from "node:assert/strict";
import test from "node:test";

import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "../fixture.mjs";
import { inputSources } from "../platform/platform.js";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { compareAppKitReference } from "./ime-reference-steps.mjs";

const { korean: KOREAN_2SET } = inputSources();
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

async function focusedTerminal(s) {
  const [terminal] = await ensureTerminals(s, 1);
  const surface = terminal.surface;
  await s.keepPointerOutside();
  const view = await s.rect("terminal.view", undefined, surface);
  const point = { x: view.document.x + view.x + view.width / 2,
    y: view.document.y + view.y + view.height / 2 };
  await s.pointer(point.x, point.y, "move", { activate: true });
  await s.click(point.x, point.y);
  await s.until("host.window", (window) => window.active && window.key && window.responder?.surface === surface,
    "the terminal view did not become the active first-responder owner");
  return { terminal, surface };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: IME Escape ends view composition as it does in AppKit`, { timeout: 90000 }, async (t) => {
    const s = await openProbe(t, app);
    const { surface } = await focusedTerminal(s);
    await s.selectInputSource(KOREAN_2SET);
    await compareAppKitReference(s, ["g", "k", "s", "Escape"], "한", ["ㅎ", "하", "한", "한"]);
    await focusedTerminal(s);
    const recording = await s.record();
    // The recording starts before the first key and remains active through the committed screen after Escape.
    for (const [key, expected] of [["g", "ㅎ"], ["k", "하"], ["s", "한"]]) {
      await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === expected,
        `the Korean input method did not produce ${expected}`, { surface });
    }
    const offsets = currentEventOffsets(s.app.configDir);
    await s.press("Escape");
    await s.until("terminal.compose", (compose) => compose.text === "",
      "Escape did not end the active composition", { surface });
    const linesAfter = await readScreenUntil(s, surface,
      (lines) => lines.some((line) => line.trimEnd().endsWith("한")),
      "Escape did not commit the AppKit reference text into the terminal document");
    assert.ok(linesAfter.some((line) => line.trimEnd().endsWith("한")),
      `the terminal document does not end in the committed AppKit text: ${JSON.stringify(linesAfter)}`);
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
