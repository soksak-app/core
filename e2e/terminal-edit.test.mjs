// Checks that the keys Command+C and Command+V run the Edit menu like a person's keys. The window takes the drag and the keys
// as the virtual key window, and the key equivalent reaches the menu through the same path as in the key window of the active
// application, so the application of the person keeps the keyboard (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";
import { pasteboardText, writePasteboard } from "@soksak/window-check/pasteboard.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: injected Command+C and Command+V run the Edit menu like a person's keys`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app, { clipboard: true, inactive: true });
    await fresh(s, { log: { input: "info", lifecycle: "info" }, reads: ["native.record.info"] });
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.run("terminal.input", { bytes: "clear; printf 'EDITMENU\\n'\r" }, surface);
    const lines = await readScreenUntil(s, surface, (screen) => screen.includes("EDITMENU"), "the line did not render");
    const row = lines.indexOf("EDITMENU");
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(view.document.x + view.x + 5, view.document.y + view.y + 5, "move");
    await s.until("host.window", (window) => window.virtualKey, "the window did not become the virtual key window");

    // After a drag selection, when another app changes the clipboard, Command+C copies the selection again.
    const cell = (column) => ({ x: view.document.x + view.x + (column + 0.5) * session.cellWidth,
      y: view.document.y + view.y + (row + 0.5) * session.cellHeight });
    const before = session.selectionReleases;
    // A selection covers a cell only when the pointer passes the middle of the cell, so the press is near the left edge of the first cell and the release is after the middle of the last cell
    // (docs/spec/persistent-services.md).
    const shift = 0.3 * session.cellWidth;
    // The existing bounded public trace distinguishes DOM capture, queued sidecar
    // input and its replies if native delivery succeeds but release is missing.
    await s.run("terminal.pointer.trace", { action: "start" }, surface);
    s.cleanup(() => s.run("terminal.pointer.trace", { action: "stop" }, surface));
    const pressed = currentEventOffsets(s.app.configDir);
    await s.pointer(cell(0).x - shift, cell(0).y, "down");
    await s.pointer(cell(3).x, cell(3).y, "drag");
    await s.pointer(cell(7).x + shift, cell(7).y, "drag");
    await s.pointer(cell(7).x + shift, cell(7).y, "up");
    try {
      await s.until("terminal.session", (value) => value.selectionReleases === before + 1, "the selection was not released", { surface });
    } catch (error) {
      // Diagnostics must not replace the original release timeout if a read fails.
      try {
        await s.flushLog();
        const records = readEvents(s.app.configDir, pressed).events
          .filter((event) => event.event === "native.record.info" && event.fields?.where === "input inject")
          .map((event) => JSON.parse(event.fields.text)).filter((record) => record.kind === "pointer");
        t.diagnostic(`${app.name}: failed selection release native pointer records ${JSON.stringify(records)}`);
      } catch (diagnosticError) {
        t.diagnostic(`${app.name}: selection release native records diagnostic failed: ${diagnosticError.stack ?? diagnosticError}`);
      }
      for (const [name, target] of [["terminal.pointer.trace", surface], ["terminal.session", surface], ["host.window", undefined]]) {
        try {
          t.diagnostic(`${app.name}: failed selection release ${name} ${JSON.stringify(await s.get(name, target))}`);
        } catch (diagnosticError) {
          t.diagnostic(`${app.name}: selection release ${name} diagnostic failed: ${diagnosticError.stack ?? diagnosticError}`);
        }
      }
      throw error;
    }
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("CHANGED").toString("base64") }]);
    await s.press("c", { modifiers: ["command"] });
    await s.until("terminal.session", () => pasteboardText() === "EDITMENU",
      `an injected Command+C did not copy the selection (the pasteboard holds ${JSON.stringify(pasteboardText())})`, { surface });

    const marker = `INJECTED${process.pid}`;
    writePasteboard([{ "public.utf8-plain-text": Buffer.from(marker).toString("base64") }]);
    await s.press("v", { modifiers: ["command"] });
    await readScreenUntil(s, surface, (screen) => screen.some((line) => line.includes(marker)),
      "an injected Command+V did not paste through the Edit menu");
    await s.run("terminal.input", { bytes: "\u0015" }, surface);
  });
}
