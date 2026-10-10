// Checks that a terminal newly opened in a project starts at the canonical root of the project (docs/spec/projects.md).
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readScreenUntil } from "./terminal-screen.mjs";

/** Adds a plugin tab to the browser card and returns its surface. A browser tab does not report a directory, so it has no origin. */
async function addTab(s, plugin) {
  const { tab } = await s.run("core.card.add-tab", { card: "browser", plugin });
  s.cleanup(() => s.run("core.tab.close", { tab }));
  await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
    item.surface === tab && item.visible && item.status.phase === "ready"),
  `the new ${plugin} tab did not become ready`);
  return tab;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a new terminal in a project starts in the project root`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // The check project is under $TMPDIR and resolves through /private, so the check compares canonical paths.
    const root = realpathSync((await s.get("core.project")).root);

    const terminal = await addTab(s, "terminal");
    await s.until("terminal.session", (state) => Boolean(state?.sessionId), "the new terminal has no session", { surface: terminal });
    // A long path continues in the next row at the screen width, so the check reads it from the row that joins the path between the markers.
    await s.run("terminal.input", { bytes: "printf 'DIR<%s>DIR\\n' \"$PWD\"\r" }, terminal);
    const printedIn = (rows) => /DIR<(\/[^>]*)>DIR/.exec(rows.join(""))?.[1];
    const lines = await readScreenUntil(s, terminal, (rows) => printedIn(rows) !== undefined,
      "the new terminal printed no directory");
    const printed = printedIn(lines);
    assert.equal(realpathSync(printed), root, `the new terminal started in ${printed}`);
  });
}
