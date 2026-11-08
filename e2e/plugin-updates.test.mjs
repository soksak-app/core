// The plugin screen lists the plugins that the registry lists in a newer version and updates them with one action
// (docs/spec/installation.md, Plugin screen).
//
// The check builds a fixture registry (scripts/fixture-registry.mjs) that lists the plain-view probe in its installed version and in
// the next one, and serves its index with a wrong hash for the next version, so the update is refused and the installation does not
// change.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { buildFixtureRegistry, nextPatch, readIndex, withWrongHash } from "../scripts/fixture-registry.mjs";
import { fixtureRegistry, fresh, restoreRegistry, useRegistry } from "./fixture.mjs";

/** The fixture plugin that the registry lists in a newer version. */
const PLUGIN = "probeplain";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the plugin screen lists the updates and 모두 업데이트 stops at a refused update`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const installed = before.plugins.find((row) => row.id === PLUGIN).installed.version;
    const newer = nextPatch(installed);

    // The index lists the plugin in a version after the installed one, with a hash that no release has.
    const folder = await fixtureRegistry({ sok: join(dirname(app.binary), "sok"), signal: t.signal,
      build: (sok, out, options) => buildFixtureRegistry(sok, out, { ...options, versions: { [PLUGIN]: [{ version: installed }, { version: newer }] } }) });
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    const { index } = readIndex(pathToFileURL(join(folder, "index.json")).href);
    mkdirSync(join(folder, "variant"));
    writeFileSync(join(folder, "variant", "index.json"), JSON.stringify(withWrongHash(index, PLUGIN, newer)));
    const address = pathToFileURL(join(folder, "variant", "index.json")).href;
    s.cleanup(async () => {
      if ((await s.get("core.screen")).screen === "library") {
        await s.run("core.library.page", { page: "projects" });
        await s.run("core.library.return");
      }
      await restoreRegistry(s);
    });

    await useRegistry(s, address);
    const listed = await s.until("core.plugins", (value) => value.registry === address && value.error === null && value.updates.length > 0,
      "the registry with a newer version did not list an update");
    assert.deepEqual(listed.updates, [{ id: PLUGIN, installed, latest: newer }]);

    // The window shows the update control with the count N while an update exists; it opens the plugin screen at the update list.
    const control = await s.rect("core.chrome.updates");
    assert.ok(control.width > 0 && control.height > 0, `the update control has no size: ${JSON.stringify(control)}`);
    await s.act("core.chrome.updates", "click");
    await s.run("core.plugins.browse");
    await s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.length > 0, "the plugin page did not show");
    const row = await s.rect("core.library.plugins.updates", 0);
    assert.ok(row.width > 0 && row.height > 0, `the update row has no size: ${JSON.stringify(row)}`);
    await s.rect("core.library.plugins.update-all", undefined);

    // The update-all action runs the update, which the wrong hash refuses, and the installation does not change.
    // The library shows the refusal through its error display, which writes the error line.
    s.expectError(/has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    await s.act("core.library.plugins.update-all", "click");
    const failed = await s.until("core.plugins", (value) => value.operation?.action === "update" && value.operation.state === "failed",
      `모두 업데이트 did not run the update of ${PLUGIN}`);
    assert.match(failed.operation.error, /has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    assert.equal(failed.plugins.find((entry) => entry.id === PLUGIN).installed.version, installed);

    // The control leaves with the last update.
    await restoreRegistry(s);
    await s.until("core.plugins", (value) => value.updates.length === 0, "the original registry still lists an update");
    await assert.rejects(s.rect("core.chrome.updates"), /core\.chrome\.updates/);
  });
}
