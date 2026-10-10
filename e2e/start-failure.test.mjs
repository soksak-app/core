// An error that stops the page start is shown as an error display and in the application log, not as an empty window (docs/features.md F86).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { readEventErrors } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a rejected installed plugin manifest stops the page start with a shown and logged error`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
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
    // The reload of a page that cannot start ends with the timeout of its request, which the host records (docs/spec/diagnostics.md).
    s.expectError(/^error host endpoint timeout: command\.run: the reloaded page did not report ready within 10s$/);
    // A page whose start stopped does not report readiness, so the reload command exceeds its deadline. The page records the error during the start,
    // so after that deadline the record is in the log.
    await assert.rejects(s.run("host.window.reload"), /did not|not ready|within/);
    await s.flushLog();
    const { errors } = readEventErrors(s.app.configDir, s.eventStart);
    const line = errors.find((item) => pattern.test(item));
    assert.ok(line, `the start failure wrote no error line: ${JSON.stringify(errors)}`);
    t.diagnostic(`logged: ${line}`);

  });
}
