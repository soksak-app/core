// A person operates the save panel of the debug view, which the native input of a check cannot reach: the panel is not
// the key window of the application that the input names. Each test opens the panel and waits for the person; the
// instruction is in the diagnostics of the run. Run it with `pnpm -F @soksak/e2e verify:person` while a person is at the
// machine (docs/operations/examples.md).
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";

/** How long the person has to operate the panel. */
const PERSON = 180000;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the save panel of the debug view saves a file where the person chooses and answers null on cancel`, { timeout: 2 * PERSON + 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await s.run("core.debug.open");
    await s.until("core.debug", (debug) => debug.open && debug.entries.some((file) => file.path === "logs/application.log"),
      "the debug view did not list the application log");
    s.cleanup(() => s.run("core.debug.close"));
    const source = readFileSync(join(app.configDir, "logs", "application.log"));

    // The panel shows the name of the file; the person presses Save in it.
    t.diagnostic(`${app.name}: PRESS SAVE in the save panel (name: application.log)`);
    const saved = await s.run("core.debug.save", { path: "logs/application.log" }, undefined, { timeout: PERSON });
    assert.equal(typeof saved?.saved, "string", `the panel answered ${JSON.stringify(saved)}`);
    s.cleanup(() => rmSync(saved.saved, { force: true }));
    assert.ok(saved.saved.endsWith("application.log") || saved.saved.includes("application"), `the saved file is ${saved.saved}`);
    assert.ok(existsSync(saved.saved), `${saved.saved} was not written`);
    // The log grows while the view runs, so the saved file starts with the log that existed before the save.
    assert.ok(readFileSync(saved.saved).subarray(0, source.length).equals(source), "the saved file does not start with the application log");

    // The person presses Cancel in the panel.
    t.diagnostic(`${app.name}: PRESS CANCEL in the save panel`);
    const cancelled = await s.run("core.debug.save", { path: "logs/application.log" }, undefined, { timeout: PERSON });
    assert.equal(cancelled?.saved ?? null, null, `a cancelled panel answered ${JSON.stringify(cancelled)}`);
  });
}
