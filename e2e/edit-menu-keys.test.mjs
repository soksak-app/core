// Checks that the keys Command+C and Command+V run the Edit menu like a person's keys. The window takes the drag and the keys
// as the virtual key window, and the key equivalent reaches the menu through the same path as in the key window of the active
// application, so the application of the person keeps the keyboard (docs/spec/exposure.md#virtual-key-window). The text field
// that fills the native document region of the input probe reports its selection and the text that Copy and Paste move.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { documentFocused, inputProbeTab } from "./input-probe.mjs";
import { pasteboardText, writePasteboard } from "@soksak/window-check/pasteboard.mjs";

const LINE = "EDITMENU";

// Waits up to timeout ms until the general pasteboard holds text. The copy event of the field comes before the Edit menu writes
// the pasteboard, so the pasteboard is read after the event, until it holds the text.
async function pasteboardHolds(text, message, timeout = 5000) {
  const until = performance.now() + timeout;
  while (pasteboardText() !== text) {
    if (performance.now() > until) throw new Error(`${message} (the pasteboard holds ${JSON.stringify(pasteboardText())})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: injected Command+C and Command+V run the Edit menu like a person's keys`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app, { clipboard: true, inactive: true });
    await fresh(s, { log: { input: "info", lifecycle: "info" }, reads: ["native.record.info"] });
    const { surface } = await inputProbeTab(s);
    await s.run("probeinput.select", { target: "document", value: LINE, start: 0 }, surface);
    await s.until("probeinput.document", (state) => state.value === LINE, "the line did not reach the document field", { surface });
    const rect = await s.rect("probeinput.text", undefined, surface);
    const left = rect.document.x + rect.x, top = rect.document.y + rect.y;
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(left + 2, top + 2, "move");
    await s.until("host.window", (window) => window.virtualKey, "the window did not become the virtual key window");

    // After a drag selection, when another app changes the clipboard, Command+C copies the selection again. The field has a
    // padding of 8 points and one line of 16-point text: the press is in the padding before the first character of the line, and
    // the release is near the right edge of the field, past the end of the line, so the drag selects the whole line.
    const row = top + 8 + 10;
    const pressed = currentEventOffsets(s.app.configDir);
    await s.pointer(left + 3, row, "down");
    await s.pointer(left + rect.width / 2, row, "drag");
    await s.pointer(left + rect.width - 12, row, "drag");
    await s.pointer(left + rect.width - 12, row, "up");
    try {
      await s.until("probeinput.document", (state) => state.caret.start === 0 && state.caret.end === LINE.length,
        "the drag did not select the line", { surface });
    } catch (error) {
      // Diagnostics must not replace the original selection timeout if a read fails.
      try {
        await s.flushLog();
        const records = readEvents(s.app.configDir, pressed).events
          .filter((event) => event.event === "native.record.info" && event.fields?.where === "input inject")
          .map((event) => JSON.parse(event.fields.text)).filter((record) => record.kind === "pointer");
        t.diagnostic(`${app.name}: failed selection native pointer records ${JSON.stringify(records)}`);
      } catch (diagnosticError) {
        t.diagnostic(`${app.name}: selection native records diagnostic failed: ${diagnosticError.stack ?? diagnosticError}`);
      }
      for (const [name, target] of [["probeinput.document", surface], ["host.window", undefined]]) {
        try {
          t.diagnostic(`${app.name}: failed selection ${name} ${JSON.stringify(await s.get(name, target))}`);
        } catch (diagnosticError) {
          t.diagnostic(`${app.name}: selection ${name} diagnostic failed: ${diagnosticError.stack ?? diagnosticError}`);
        }
      }
      throw error;
    }
    await s.until("host.window", (window) => window.responder?.surface === surface && documentFocused(window, surface),
      "the document region did not take native focus");
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("CHANGED").toString("base64") }]);
    await s.press("c", { modifiers: ["command"] });
    await s.until("probeinput.document", (state) => state.copies.some((copy) => copy.text === LINE),
      "an injected Command+C did not run Copy on the selection", { surface });
    await pasteboardHolds(LINE, "an injected Command+C did not copy the selection");

    const marker = `INJECTED${process.pid}`;
    writePasteboard([{ "public.utf8-plain-text": Buffer.from(marker).toString("base64") }]);
    await s.press("v", { modifiers: ["command"] });
    await s.until("probeinput.document", (state) => state.pastes.some((paste) => paste.text === marker) && state.value.includes(marker),
      "an injected Command+V did not paste through the Edit menu", { surface });
    const { copies, pastes } = await s.get("probeinput.document", surface);
    assert.deepEqual([copies.length, pastes.length], [1, 1], "a key equivalent ran its Edit menu item more than once");
  });
}
