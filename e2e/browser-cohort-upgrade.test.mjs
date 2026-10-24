// The official CLI upgrades the browser in a disposable copy of the F239-27 Wails profile. This check verifies the
// resulting starter cohort through declared application statuses; it does not install packages or launch a host.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser upgrade keeps the candidate starter cohort ready`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
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
    assert.deepEqual(versions, { browser: "0.0.7", files: "0.0.7", terminal: "0.0.15" });
    const files = plugins.plugins.find((plugin) => plugin.id === "files");
    const terminal = plugins.plugins.find((plugin) => plugin.id === "terminal");
    assert.equal(files.sidecars.find((sidecar) => sidecar.name === "@soksak/sidecar-files")?.version, "0.0.8",
      "the Files sidecar is not the candidate self-identity build");
    assert.equal(terminal.sidecars.find((sidecar) => sidecar.name === "@soksak/sidecar-vt-alacritty")?.version, "0.0.13",
      "the VT sidecar is not the candidate self-identity build");

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
