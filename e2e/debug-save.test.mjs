// The save panel of the debug view, driven with emulated input. The panel is a sheet of the window, which host.window reports in
// `sheet`; the panel object of the application takes its name, Return and Escape, so the panel saves and cancels as a person's
// Save and Cancel do while the person keeps the keyboard (docs/spec/exposure.md#virtual-key-window). The mygo host shows the
// panel as an application-modal panel, which activates the application, only for a window that is not visible
// (internal/darwin/dialog.go of mygo); the window of a check is visible behind the windows of the person, so every host shows a
// sheet.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

/**
 * Starts core.debug.save of path and waits until its save panel is the sheet of the window. Returns `{ answer }`, the pending
 * answer of the command, which the panel gives when it ends.
 */
async function saveAsked(s, path) {
  const answer = s.run("core.debug.save", { path });
  // A failure of the command before its panel shows ends the wait on the sheet with that failure.
  const failed = answer.then(() => new Promise(() => {}));
  await Promise.race([failed, s.until("host.window", (window) => window.sheet?.kind === "save", "the save panel did not show")]);
  return { answer };
}

/** Waits until the window has no sheet. */
function sheetEnded(s) {
  return s.until("host.window", (window) => window.sheet === null, "the save panel did not end");
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the save panel of the debug view saves with Return, under a typed name, and answers null on Escape`, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s);
    await s.run("core.debug.open");
    const isEventLog = (file) => /^logs\/host-.+\.jsonl$/.test(file.path);
    const listing = await s.until("core.debug", (debug) => debug.open && debug.entries.some(isEventLog),
      "the debug view did not list the event log of the host");
    s.cleanup(() => s.run("core.debug.close"));
    const entry = listing.entries.find(isEventLog).path;
    const name = entry.split("/").at(-1);
    const source = readFileSync(join(app.configDir, entry));
    const savedAs = async (expected) => {
      const saved = await pending.answer;
      assert.equal(typeof saved?.saved, "string", `the panel answered ${JSON.stringify(saved)}`);
      s.cleanup(() => rmSync(saved.saved, { force: true }));
      assert.ok(saved.saved.endsWith(`/${expected}`), `the saved file is ${saved.saved}, not ${expected}`);
      assert.ok(existsSync(saved.saved), `${saved.saved} was not written`);
      // The event log grows while the view runs, so the saved file starts with the log that existed before the save.
      assert.ok(readFileSync(saved.saved).subarray(0, source.length).equals(source), "the saved file does not start with the event log");
      await sheetEnded(s);
    };

    // Return saves under the name that the panel shows, in the folder of the panel.
    let pending = await saveAsked(s, entry);
    await s.press("Enter");
    await savedAs(name);

    // Escape cancels, and the command answers no file.
    pending = await saveAsked(s, entry);
    await s.press("Escape");
    const cancelled = await pending.answer;
    assert.equal(cancelled?.saved ?? null, null, `a cancelled panel answered ${JSON.stringify(cancelled)}`);
    await sheetEnded(s);

    // Backspace removes the extension and a committed text types another one, so the file is saved under the typed name.
    pending = await saveAsked(s, entry);
    for (const _ of ".jsonl") await s.press("Backspace");
    await s.text("insert", "-typed.jsonl");
    await s.press("Enter");
    await savedAs(name.replace(/\.jsonl$/, "-typed.jsonl"));
  });
}
