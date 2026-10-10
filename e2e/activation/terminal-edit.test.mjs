// Activation-tier window check: checks that the diagnostic keys Command+C and Command+V run the Edit menu like human keys.
//
// A diagnostic key goes through the dispatch of NSApplication. The key-equivalent behavior of the menu goes to the key window of the active application, so this check
// activates the app. A run that the user approved runs it only through pnpm -F @soksak/e2e verify:activation.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { pasteboardText, writePasteboard } from "@soksak/window-check/pasteboard.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: injected Command+C and Command+V run the Edit menu like a person's keys`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await s.run("terminal.input", { bytes: "clear; printf 'EDITMENU\\n'\r" }, surface);
    const lines = await readScreenUntil(s, surface, (screen) => screen.includes("EDITMENU"), "the line did not render");
    const row = lines.indexOf("EDITMENU");
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    await s.keepPointerOutside();
    await s.pointer(view.document.x + view.x + 5, view.document.y + view.y + 5, "move", { activate: true });
    await s.until("host.window", (window) => window.active === true && window.key === true, "the window did not become key");

    // After a drag selection, when another app changes the clipboard, Command+C copies the selection again.
    const cell = (column) => ({ x: view.document.x + view.x + (column + 0.5) * session.cellWidth,
      y: view.document.y + view.y + (row + 0.5) * session.cellHeight });
    const before = session.selectionReleases;
    // A selection covers a cell only when the pointer passes the middle of the cell, so the press is near the left edge of the first cell and the release is after the middle of the last cell
    // (docs/spec/terminal-runtime.md).
    const shift = 0.3 * session.cellWidth;
    await s.pointer(cell(0).x - shift, cell(0).y, "down");
    await s.pointer(cell(3).x, cell(3).y, "drag");
    await s.pointer(cell(7).x + shift, cell(7).y, "drag");
    await s.pointer(cell(7).x + shift, cell(7).y, "up");
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1, "the selection was not released", { surface });
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
