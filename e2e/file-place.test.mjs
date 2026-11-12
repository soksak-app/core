// The save place of a new document (docs/spec/plugins.md#pluginjson). The host refuses a name that is not a file name before it
// asks. Otherwise the check holds the dialogs of its window (docs/spec/exposure.md#dialogs), so the place is a request of
// host.dialog with the name: an answer inside the project root gives the path relative to the root, an answer outside it is
// refused after the answer, and a cancel answers no path. The command only chooses the place, so no file is written.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, holdDialogs } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: core.file.place refuses a name that is not a file name before the save panel`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // A refused command is an error that the check causes on purpose.
    s.expectError(/file place: name .* is not a file name/);
    for (const name of ["", "..", "docs/plan.hwp"]) {
      await assert.rejects(s.run("core.file.place", { name }), (error) => error.message.includes(`file place: name ${name} is not a file name`),
        `core.file.place did not refuse the name ${JSON.stringify(name)}`);
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: core.file.place asks host.dialog for the place of the name and answers it relative to the project root, refuses a place outside the root and answers null on a cancel`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const root = realpathSync((await s.get("core.project")).root);
    let name = "check-place.txt";
    for (let index = 2; existsSync(join(root, name)); index++) name = `check-place-${index}.txt`;
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "soksak-file-place-")));
    s.cleanup(() => rmSync(outside, { recursive: true, force: true }));
    const dialogs = await holdDialogs(s);

    // The place is a request with the name; an answer inside the root gives the path relative to it, and no file is written.
    let answer = s.run("core.file.place", { name });
    let request = await dialogs.asked(answer, "core.file.place");
    assert.equal(request.kind, "save", `core.file.place asked for ${JSON.stringify(request)}`);
    assert.equal(request.suggestedName, name, `core.file.place proposed ${JSON.stringify(request.suggestedName)}`);
    assert.equal((await s.get("host.window")).sheet, null, "core.file.place showed a panel");
    await s.request("input.dialog.answer", { id: request.id, paths: [join(root, name)] });
    assert.deepEqual(await answer, { path: name });
    assert.equal(existsSync(join(root, name)), false, "core.file.place wrote the file of the place");

    // A place outside the project root passes the checks of the panel and is refused by the command.
    s.expectError(/file place: .* is outside the project /);
    answer = s.run("core.file.place", { name });
    request = await dialogs.asked(answer, "core.file.place");
    await s.request("input.dialog.answer", { id: request.id, paths: [join(outside, name)] });
    await assert.rejects(answer, (error) => error.message.includes(`file place: ${join(outside, name)} is outside the project`),
      "core.file.place took a place outside the project root");

    // A cancel answers no path.
    answer = s.run("core.file.place", { name });
    request = await dialogs.asked(answer, "core.file.place");
    await dialogs.end(() => s.request("input.dialog.answer", { id: request.id, cancel: true }));
    assert.deepEqual(await answer, { path: null });
  });
}
