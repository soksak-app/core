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
import { fixtureRegistry, nextPatch, readIndex, withWrongHash } from "../scripts/fixture-registry.mjs";
import { fresh, restoreRegistry, useRegistry } from "./fixture.mjs";

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
      versions: { [PLUGIN]: [{ version: installed }, { version: newer }] } });
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    const { index } = readIndex(pathToFileURL(join(folder, "index.json")).href);
    mkdirSync(join(folder, "variant"));
    writeFileSync(join(folder, "variant", "index.json"), JSON.stringify(withWrongHash(index, PLUGIN, newer)));
    const address = pathToFileURL(join(folder, "variant", "index.json")).href;
    s.cleanupSteps(
      async () => {
        if ((await s.get("core.settings-tab")) !== null) await s.run("core.settings.close");
      },
      async () => {
        await restoreRegistry(s);
      },
    );

    await useRegistry(s, address);
    const listed = await s.until("core.plugins", (value) => value.registry === address && value.error === null && value.updates.length > 0,
      "the registry with a newer version did not list an update");
    assert.deepEqual(listed.updates, [{ id: PLUGIN, installed, latest: newer }]);

    // The window shows the update control with the count N while an update exists; it opens the page Installed at the update list.
    await s.run("core.plugins.show-updates");
    await s.until("core.settings-tab", (tab) => tab?.page === "installed" && tab.filter === "updates" && tab.listed.length > 0,
      "the settings tab did not show the update list on 설치됨");
    await s.rect("core.settings-tab.plugins.update-all", undefined);

    // The update-all action runs the update, which the wrong hash refuses, and the installation does not change.
    // The settings tab shows the refusal through its error display, which writes the error line.
    s.expectError(/has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    await s.act("core.settings-tab.plugins.update-all", "click");
    const failed = await s.until("core.plugins", (value) => value.operation?.action === "update" && value.operation.state === "failed",
      `모두 업데이트 did not run the update of ${PLUGIN}`);
    assert.match(failed.operation.error, /has sha256 [0-9a-f]{64}, the entry says 0{64}/);
    assert.equal(failed.plugins.find((entry) => entry.id === PLUGIN).installed.version, installed);

    // The updates leave the list with the last update.
    await restoreRegistry(s);
    await s.until("core.plugins", (value) => value.updates.length === 0, "the original registry still lists an update");
  });
}
