// Extension points end to end (docs/spec/plugins.md#extension-points): a provider probe declares the point items, a contributor
// probe contributes one item and names the provider in its dependencies. The check packs both probes into a registry of its
// own beside the workspace plugins, installs the contributor, which installs the provider with it, and requires that the item
// is connected in core.contributions and that the provider page imports its module and reports its answer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry } from "../scripts/workspace-registry.mjs";
import { fresh, pluginChangeApplied } from "./fixture.mjs";

const REGISTRY = fileURLToPath(new URL("../target/registry/", import.meta.url));
const PROBES = fileURLToPath(new URL("./fixtures/extension-probe/", import.meta.url));

/** A registry folder with the entries of the workspace registry and the two probes, and its built index. */
function probeRegistry(sok) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-extension-registry-"));
  for (const name of ["plugins", "sidecars", "packs", "revoked.json"]) cpSync(join(REGISTRY, name), join(folder, name), { recursive: true });
  const sidecars = new Set(readdirSync(join(folder, "sidecars")).map((file) => JSON.parse(readFileSync(join(folder, "sidecars", file), "utf8")).name));
  for (const probe of ["provider", "contributor"]) {
    const dir = join(PROBES, probe);
    const pack = JSON.parse(execFileSync(sok, ["plugin", "pack", dir, join(folder, "releases")], { encoding: "utf8" }));
    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    writeFileSync(join(folder, "plugins", `${manifest.id}.json`), JSON.stringify(pluginEntry(manifest, pkg, pack, sidecars), null, 2));
  }
  execFileSync(sok, ["registry", "build", folder], { encoding: "utf8" });
  return folder;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a contributed item connects to the extension point of its provider and the provider uses it`, { timeout: 180000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const before = await s.get("core.plugins");
    const folder = probeRegistry(join(dirname(app.binary), "sok"));
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    s.cleanup(async () => {
      await s.windows(1, "the page was not ready for the cleanup");
      for (const id of ["probecontributor", "probeprovider"]) {
        if (!(await s.get("core.plugins")).plugins.find((row) => row.id === id)?.installed) continue;
        const offsets = currentEventOffsets(app.configDir);
        await s.run("core.plugins.remove", { plugin: id });
        await pluginChangeApplied(s, offsets, `remove ${id} in the cleanup`);
      }
      await s.run("core.plugins.registry", { index: before.registry });
    });
    await s.run("core.plugins.registry", { index: pathToFileURL(join(folder, "index.json")).href });
    await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === "probecontributor"), "the probe registry did not list the contributor");
    const offsets = currentEventOffsets(app.configDir);
    await s.run("core.plugins.install", { plugin: "probecontributor" });
    await pluginChangeApplied(s, offsets, "install probecontributor");
    const installed = (await s.get("core.plugins")).plugins;
    for (const id of ["probecontributor", "probeprovider"]) {
      assert.ok(installed.find((row) => row.id === id)?.installed, `${id} is not installed after the install of the contributor`);
    }
    await s.until("core.contributions", (items) => items.some((item) => item.plugin === "probecontributor"
      && item.point === "probeprovider.items" && item.state === "connected"),
    "the contributed item is not connected to the point of the provider");
    const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null).id;
    const { tab } = await s.run("core.card.add-tab", { card, plugin: "probeprovider" });
    s.cleanup(() => s.run("core.tab.close", { tab }));
    const answers = await s.until("probeprovider.items", (value) => Array.isArray(value) && value.length === 1,
      "the provider page did not report the answer of the contributed item", { surface: tab });
    assert.deepEqual(answers, [{ plugin: "probecontributor", label: "probe item", answer: "contributed: probe item" }]);
  });
}
