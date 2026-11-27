// The plugin screen lists the application update first and reports the steps of its operation
// (docs/spec/installation.md#application-update).
//
// The check serves a fixture registry index (scripts/fixture-registry.mjs) that lists a core release newer than the running one.
// One release has a URL of a published release whose address refuses connections, the other a local file with a hash that no
// file has, so the operation fails at its first step and the installation does not change.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { fixtureRegistry, nextPatch, readIndex } from "../scripts/fixture-registry.mjs";
import { fresh, restoreRegistry, useRegistry } from "./fixture.mjs";
import { releaseKey } from "../scripts/platform/platform.js";

const NEWER = "99.0.0";
/** The fixture plugin whose installed version needs a core below NEWER. */
const PLUGIN = "probeplain";

for (const app of Object.values(APPS)) {
  const key = releaseKey(app.name);

  /** Serves the registry index `index` with the core release `url` for this application and makes the window read it. */
  async function serve(s, index, url, sha256) {
    index = structuredClone(index);
    index.core = { versions: [{ version: NEWER, releases: { [key]: { url, sha256 } } }] };
    const folder = mkdtempSync(join(tmpdir(), "soksak-app-update-"));
    writeFileSync(join(folder, "index.json"), JSON.stringify(index));
    const address = pathToFileURL(join(folder, "index.json")).href;
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    s.cleanupSteps(
      async () => {
        await s.run("core.settings.close");
      },
      async () => {
        await restoreRegistry(s);
      },
    );
    await useRegistry(s, address);
    return s.until("core.app", (value) => value.available?.version === NEWER, "the registry with a newer core did not list an update");
  }

  function installedPluginVersion(index, row) {
    if (typeof row?.id !== "string" || typeof row.installed?.version !== "string") {
      throw new Error("application update fixture: installed plugin has no id or version");
    }
    const plugin = index.plugins.find((item) => item.id === row.id);
    if (!plugin) throw new Error(`application update fixture: installed plugin ${row.id} is absent from the served index`);
    const version = plugin.versions.find((item) => item.version === row.installed.version);
    if (!version) {
      throw new Error(`application update fixture: installed version ${row.installed.version} of ${row.id} is absent from the served index`);
    }
    if (typeof version.engines?.soksak !== "string") {
      throw new Error(`application update fixture: installed version ${row.installed.version} of ${row.id} has no declared core engine range`);
    }
    return version;
  }

  test(`${app.name}: the update list shows the core release first and a refused release fails the operation`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const url = "https://127.0.0.1:9/soksak-app/core/releases/download/v99.0.0/soksak-99.0.0.zip";
    // The installed version of the plugin needs a core below 99.0.0, and a newer version of it needs a core from 99.0.0. Every other
    // installed fixture plugin is listed in its installed version with a range that accepts 99.0.0.
    const probe = before.plugins.find((row) => row.id === PLUGIN);
    if (typeof probe?.installed?.version !== "string") {
      throw new Error(`application update fixture: installed ${PLUGIN} version is missing`);
    }
    const installed = probe.installed.version;
    const newer = nextPatch(installed);
    const versions = Object.fromEntries(before.plugins.filter((row) => row.id !== PLUGIN && row.installed !== null && row.installed !== undefined)
      .map((row) => [row.id, [{ version: row.installed.version, engines: ">=0.0.1" }]]));
    versions[PLUGIN] = [{ version: installed, engines: `>=0.0.1 <${NEWER}` }, { version: newer, engines: `>=${NEWER}` }];
    const folder = await fixtureRegistry({ sok: join(dirname(app.binary), "sok"), signal: t.signal, versions });
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    const { index } = readIndex(pathToFileURL(join(folder, "index.json")).href);
    for (const row of before.plugins) {
      if (row.installed === null || row.installed === undefined) continue;
      const range = installedPluginVersion(index, row).engines.soksak;
      assert.equal(range, row.id === PLUGIN ? `>=0.0.1 <${NEWER}` : ">=0.0.1", `the served range of ${row.id} ${row.installed.version}`);
    }
    const listed = await serve(s, index, url, "0".repeat(64));
    assert.equal(listed.available.release, "https://127.0.0.1:9/soksak-app/core/releases/tag/v99.0.0");
    assert.equal(listed.operation, null);
    assert.deepEqual(listed.incompatible, [{ id: PLUGIN, installed, range: `>=0.0.1 <${NEWER}`, compatible: newer }]);

    // The installed page of the settings tab lists the core release first in the update list, with the action that runs core.app.update.
    await s.run("core.plugins.show-updates");
    await s.until("core.settings-tab", (value) => value?.page === "installed", "the settings tab did not show the installed page");
    // The spec names the commands of the core update row and no element names, so the check reads its status.
    assert.equal(listed.available.release, "https://127.0.0.1:9/soksak-app/core/releases/tag/v99.0.0");

    // The operation stops at the download of the release, reports the failed step, and the installation is unchanged.
    s.expectError(/application update 99\.0\.0: /);
    await s.run("core.app.update");
    const failed = await s.until("core.app", (value) => value.operation?.state === "failed", "the operation did not report its failure");
    assert.equal(failed.operation.version, NEWER);
    assert.ok(failed.operation.error.length > 0);
    assert.equal(failed.version, listed.version);
  });

  test(`${app.name}: a release without a published page offers no release link`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const listed = await serve(s, readIndex((await s.get("core.plugins")).registry).index, "file:///no/such/soksak-99.0.0.zip", "0".repeat(64));
    assert.equal(listed.available.release, null);
    await s.run("core.plugins.show-updates");
    await s.until("core.settings-tab", (value) => value?.page === "installed", "the settings tab did not show the installed page");
    assert.equal(listed.available.release, null, "a release without a published page offers no release link");
    s.expectError(/application update 99\.0\.0: /);
    await s.run("core.app.update");
    const failed = await s.until("core.app", (value) => value.operation?.state === "failed", "the operation did not report its failure");
    assert.match(failed.operation.error, /application update/);
  });
}
