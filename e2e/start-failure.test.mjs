// An installed plugin whose manifest the page refuses is left out with its error shown and in the application log, and the page
// starts without it (docs/spec/installation.md#serving-installed-plugins). A refused projects.json is left out of the workspace
// snapshot with its error shown and in the application log, and the page starts without it (docs/spec/projects.md#settings).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readEventErrors } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a rejected installed plugin manifest is shown and logged and the page starts without that plugin`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // Changes the manifest of the installed terminal plugin to the earlier form that lists the sidecar in sidecars instead of dependencies.
    const installed = JSON.parse(readFileSync(join(s.app.configDir, "plugins", "installed.json"), "utf8"));
    const record = installed.plugins.terminal;
    const file = join(s.app.configDir, record.path, "plugin.json");
    const original = readFileSync(file, "utf8");
    const manifest = JSON.parse(original);
    const { dependencies, ...rest } = manifest;
    // Restores the earlier manifest and reloads the page so that the next check starts from a page that it started.
    s.cleanup(async () => {
      writeFileSync(file, original);
      await s.run("host.window.reload");
    });
    writeFileSync(file, JSON.stringify({ ...rest, sidecars: Object.keys(dependencies) }, null, 2));

    const pattern = /^error page page: installed plugin terminal \S+ \(@soksak\/plugin-terminal\): plugin\.json: unknown field sidecars/;
    s.expectError(pattern);
    // The page starts without the refused plugin, so the reload reports ready, and the error display wrote the refusal to the log.
    await s.run("host.window.reload");
    await s.flushLog();
    const { errors } = readEventErrors(s.app.configDir, s.eventStart);
    const line = errors.find((item) => pattern.test(item));
    assert.ok(line, `the start failure wrote no error line: ${JSON.stringify(errors)}`);
    t.diagnostic(`logged: ${line}`);

  });

  test(`${app.name}: a refused projects.json is shown and logged and the page starts without it`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // projects.json of another form is left out of the workspace snapshot of the start document with its error.
    const file = join(s.app.configDir, "projects.json");
    const original = readFileSync(file, "utf8");
    s.cleanup(async () => {
      writeFileSync(file, original);
      await s.run("host.window.reload");
    });
    writeFileSync(file, "[]");

    const pattern = /^error page page: .*projects\.json: projects\.json: format must be 1$/;
    s.expectError(pattern);
    // The reload resolves when the reloaded page reports ready.
    await s.run("host.window.reload");
    assert.equal(readFileSync(file, "utf8"), "[]", "the start changed the refused projects.json");
    await s.flushLog();
    const { errors } = readEventErrors(s.app.configDir, s.eventStart);
    const line = errors.find((item) => pattern.test(item));
    assert.ok(line, `the refused projects.json wrote no error line: ${JSON.stringify(errors)}`);
    t.diagnostic(`logged: ${line}`);
  });
}
