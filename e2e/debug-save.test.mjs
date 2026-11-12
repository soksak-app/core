// The save of the debug view, answered through host.dialog (docs/spec/exposure.md#dialogs). While the check holds the dialogs of
// its window, the save shows no panel: its place waits as a request that the check answers with a path in a folder of its own,
// so the check never shows a panel to the person and never writes into a folder of the person. The answer passes the checks of
// the panel of a person: the name of an existing file is refused without replace and the request keeps waiting, and a cancel
// answers no file.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, holdDialogs } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the save of the debug view is a request of host.dialog that an answer saves into a folder of the check, refuses an existing file without replace and cancels`, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s);
    await s.run("core.debug.open");
    const isEventLog = (file) => /^logs\/host-.+\.jsonl$/.test(file.path);
    const listing = await s.until("core.debug", (debug) => debug.open && debug.entries.some(isEventLog),
      "the debug view did not list the event log of the host");
    s.cleanup(() => s.run("core.debug.close"));
    // Opening the view writes a still capture of each window into logs/captures; the check removes the folders it caused.
    for (const path of listing.captures) s.trackRecording(dirname(path));
    const entry = listing.entries.find(isEventLog).path;
    const name = entry.split("/").at(-1);
    const source = readFileSync(join(app.configDir, entry));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "soksak-debug-save-")));
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    const dialogs = await holdDialogs(s);

    // The save asks for the place of the file with its name and shows no panel. The answer saves it there.
    let answer = s.run("core.debug.save", { path: entry });
    let request = await dialogs.asked(answer, "core.debug.save");
    assert.equal(request.kind, "save", `the save asked for ${JSON.stringify(request)}`);
    assert.equal(request.suggestedName, name, `the save proposed ${JSON.stringify(request.suggestedName)}`);
    assert.equal((await s.get("host.window")).sheet, null, "the save showed a panel");
    const target = join(folder, name);
    await s.request("input.dialog.answer", { id: request.id, paths: [target] });
    const saved = await answer;
    assert.equal(saved?.saved, target, `the save answered ${JSON.stringify(saved)}`);
    // The event log grows while the view runs, so the saved file starts with the log that existed before the save.
    const written = readFileSync(target);
    assert.ok(written.subarray(0, source.length).equals(source), "the saved file does not start with the event log");

    // The name of the saved file is refused without replace, and the request keeps waiting. The cancel answers no file.
    answer = s.run("core.debug.save", { path: entry });
    request = await dialogs.asked(answer, "core.debug.save");
    await assert.rejects(s.request("input.dialog.answer", { id: request.id, paths: [target] }), (error) => {
      assert.equal(error.code, -32602, error.message);
      assert.match(error.message, /exists/);
      return true;
    });
    assert.deepEqual((await s.get("host.dialog")).pending.map((pending) => pending.id), [request.id],
      "the refused answer did not leave the request waiting");
    await dialogs.end(() => s.request("input.dialog.answer", { id: request.id, cancel: true }));
    const cancelled = await answer;
    assert.equal(cancelled?.saved ?? null, null, `a cancelled save answered ${JSON.stringify(cancelled)}`);
    assert.ok(existsSync(target) && readFileSync(target).equals(written), `${target} changed after the refused answer`);
  });
}
