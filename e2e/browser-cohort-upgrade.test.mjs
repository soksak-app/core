// The official CLI upgrades the browser in a disposable copy of the F239-27 Wails profile. This check verifies the
// resulting starter cohort through declared application statuses; it does not install packages or launch a host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APPS, open, prepareFixture } from "@soksak/window-check/app.mjs";

// The candidate registry is built for the core under test, so installation selects the newest version that it lists.
const newest = (versions) => versions.map((entry) => entry.version)
  .sort((a, b) => b.split(".").map(Number).reduce((order, part, i) => order || part - Number(a.split(".")[i]), 0))[0];

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser upgrade keeps the candidate starter cohort ready`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    // The check starts from the layout of the test project, which holds browser and terminal surfaces; a new
    // configuration shows no project and no surface.
    await prepareFixture(s);
    const registry = process.env.SOKSAK_CANDIDATE_REGISTRY;
    assert.ok(registry, "SOKSAK_CANDIDATE_REGISTRY must name the frozen local candidate index");
    assert.match(registry, /^file:\/\//, `the candidate registry is not a local file URL: ${registry}`);

    const plugins = await s.until("core.plugins", (value) => value.registry === registry && value.error === null &&
      ["browser", "files", "terminal"].every((id) => {
        const plugin = value.plugins.find((row) => row.id === id);
        return plugin?.installed?.enabled === true && plugin.state === "loaded";
      }), "the candidate starter plugins did not load from the selected registry");
    const versions = Object.fromEntries(plugins.plugins
      .filter((plugin) => ["browser", "files", "terminal"].includes(plugin.id))
      .map((plugin) => [plugin.id, plugin.installed.version]));
    const index = JSON.parse(readFileSync(fileURLToPath(registry), "utf8"));
    const listed = (rows, key, id) => {
      const row = rows.find((entry) => entry[key] === id);
      assert.ok(row, `the candidate registry lists no ${id}`);
      return newest(row.versions);
    };
    assert.deepEqual(versions, Object.fromEntries(["browser", "files", "terminal"].map((id) => [id, listed(index.plugins, "id", id)])),
      "the installed starter plugins are not the versions of the candidate registry");
    const files = plugins.plugins.find((plugin) => plugin.id === "files");
    const terminal = plugins.plugins.find((plugin) => plugin.id === "terminal");
    for (const [plugin, name] of [[files, "@soksak/sidecar-files"], [terminal, "@soksak/sidecar-vt-alacritty"]]) {
      assert.equal(plugin.sidecars.find((sidecar) => sidecar.name === name)?.version, listed(index.sidecars, "name", name),
        `${name} is not the version of the candidate registry`);
    }

    const ready = await s.until("core.surfaces", (surfaces) => ["browser", "terminal"].every((plugin) =>
      surfaces.some((surface) => surface.plugin === plugin && surface.status.phase === "ready")),
    "the browser and terminal surfaces did not become ready");
    for (const plugin of ["browser", "terminal"]) {
      assert.ok(ready.some((surface) => surface.plugin === plugin && surface.status.phase === "ready"),
        `${plugin} has no ready surface`);
    }

    assert.equal(await s.get("core.page.error"), null, "the page reports an application error");
    assert.equal((await s.get("core.verify")).failed, 0, "the page reports failed verification checks");
  });
}
