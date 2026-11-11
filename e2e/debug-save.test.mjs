// The save panel of the debug view, driven with emulated input. The panel is a sheet of the window, which host.window reports in
// `sheet` with the folder that the panel shows and the name in its name field. The panel saves into the folder that it remembers,
// which may be a folder of the person, so the check never removes a file it did not save: it types a name that no file of that
// folder has, and removes only the file that its Return saved. The panel object of the application takes its name, Return and
// Escape, so the panel saves and cancels as a person's Save and Cancel do while the person keeps the keyboard
// (docs/spec/exposure.md#virtual-key-window). The mygo host shows the
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
 * Starts core.debug.save of path and waits until its save panel is the sheet of the window. Returns `{ answer, sheet }`: the
 * pending answer of the command, which the panel gives when it ends, and the sheet that host.window reported.
 */
async function saveAsked(s, path) {
  const answer = s.run("core.debug.save", { path });
  // A failure of the command before its panel shows ends the wait on the sheet with that failure.
  const failed = answer.then(() => new Promise(() => {}));
  const window = await Promise.race([failed,
    s.until("host.window", (value) => value.sheet?.kind === "save", "the save panel did not show")]);
  return { answer, sheet: window.sheet };
}

/** Waits until the window has no sheet. */
function sheetEnded(s) {
  return s.until("host.window", (window) => window.sheet === null, "the save panel did not end");
}

/** The first name `<stem>-check-<n>.jsonl` of name that no file of directory has. */
function freeName(directory, name) {
  const stem = name.replace(/\.jsonl$/, "");
  for (let index = 1; ; index++) {
    const candidate = `${stem}-check-${index}.jsonl`;
    if (!existsSync(join(directory, candidate))) return candidate;
  }
}

/** Replaces the name in the name field of the save panel with name: Backspace removes each character and input.text types it. */
async function rename(s, shown, name) {
  for (const _ of shown) await s.press("Backspace");
  await s.text("insert", name);
  const { sheet } = await s.get("host.window");
  assert.equal(sheet?.name, name, `the name field of the save panel holds ${JSON.stringify(sheet?.name)}`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the save panel of the debug view saves under a typed name with Return, refuses an existing name and answers null on Escape`, async (t) => {
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

    // The panel shows the name of the file in the folder that it remembers. Return saves the file there under the typed name.
    let { answer, sheet } = await saveAsked(s, entry);
    assert.equal(sheet.name, name, `the save panel shows the name ${JSON.stringify(sheet.name)}`);
    assert.equal(typeof sheet.directory, "string", `the save panel reports the folder ${JSON.stringify(sheet.directory)}`);
    const directory = sheet.directory;
    const typed = freeName(directory, name);
    await rename(s, sheet.name, typed);
    await s.press("Enter");
    const saved = await answer;
    assert.equal(saved?.saved, join(directory, typed), `the panel answered ${JSON.stringify(saved)}`);
    s.cleanup(() => rmSync(saved.saved, { force: true }));
    // The event log grows while the view runs, so the saved file starts with the log that existed before the save.
    assert.ok(readFileSync(saved.saved).subarray(0, source.length).equals(source), "the saved file does not start with the event log");
    await sheetEnded(s);

    // Return refuses the name of the file that the panel just saved, which it does not replace (the native record of the key names
    // the existing path), and the panel stays. Escape then cancels, and the command answers no file.
    ({ answer, sheet } = await saveAsked(s, entry));
    assert.equal(sheet.directory, directory, "the save panel shows another folder than the one it saved into");
    await rename(s, sheet.name, typed);
    await assert.rejects(s.key("Enter", "down"), (error) => {
      assert.equal(error.code, -32602, error.message);
      return true;
    });
    await s.key("Enter", "up");
    assert.equal((await s.get("host.window")).sheet?.kind, "save", "the save panel ended on the refused Return");
    await s.press("Escape");
    const cancelled = await answer;
    assert.equal(cancelled?.saved ?? null, null, `a cancelled panel answered ${JSON.stringify(cancelled)}`);
    await sheetEnded(s);
    assert.ok(existsSync(saved.saved), `${saved.saved} is gone after the refused Return`);
  });
}
