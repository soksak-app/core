// The floor of the view drag benchmark (docs/operations/examples.md, F502-2 and F502-25): with FLOOR=1 the benchmark drags a card whose
// view page draws one colour and runs no plugin code, so the drag measures the host and the web view alone. The page is the plugin
// floorpage of e2e/fixtures/view-drag/floor-page; its colour is the measurement colour of the terminal geometry
// (TERMINAL_GEOMETRY_BACKGROUND of cases/terminal.mjs), so the geometry rule of the drag reads its view as it reads a terminal view. The
// benchmark packs the plugin into a registry of its own beside the workspace registry and installs it from there.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry, pnpmPack } from "../../../scripts/workspace-registry.mjs";
import { pluginChangeApplied } from "../../fixture.mjs";

/** The floor page plugin: its id and its folder. */
export const FLOOR_PAGE = Object.freeze({
  plugin: "floorpage",
  folder: fileURLToPath(new URL("../../fixtures/view-drag/floor-page/", import.meta.url)),
});

/** The workspace registry that `make registry` writes. */
export const WORKSPACE_REGISTRY = fileURLToPath(new URL("../../../target/registry/", import.meta.url));

/**
 * A new registry folder with the entries of the registry `registry` and the plugin of the folder `plugin`, packed with `pack`, and the
 * index that `sok registry build` writes into it, run through `run`. The caller removes the folder.
 */
export function fixtureRegistry({ sok, registry = WORKSPACE_REGISTRY, plugin, pack = pnpmPack, run = execFileSync }) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-fixture-registry-"));
  for (const name of ["plugins", "sidecars", "packs", "revoked.json"]) cpSync(join(registry, name), join(folder, name), { recursive: true });
  const sidecars = new Set(readdirSync(join(folder, "sidecars")).map((file) => JSON.parse(readFileSync(join(folder, "sidecars", file), "utf8")).name));
  const release = pack(plugin, join(folder, "releases"));
  const manifest = JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8"));
  writeFileSync(join(folder, "plugins", `${manifest.id}.json`), JSON.stringify(pluginEntry(manifest, pkg, release, sidecars), null, 2));
  run(sok, ["registry", "build", folder], { encoding: "utf8" });
  return folder;
}

/** Runs a plugin operation that changes installed.json and waits until the page has started again (pluginChangeApplied of fixture.mjs). */
async function pluginChange(s, run, action) {
  const offsets = currentEventOffsets(s.app.configDir);
  await run();
  await pluginChangeApplied(s, offsets, action);
}

/**
 * Installs the floor page in the application of the session `s` from a fixture registry and opens it as the active tab of the terminal
 * card; returns the surface of the tab. The cleanups close the tab, remove the plugin, set the registry of the application back and
 * remove the registry folder. `registry()` writes the fixture registry, `applied(s, run, action)` runs a plugin change and waits until
 * it is applied, and `remove(folder)` removes the registry folder.
 */
export async function openFloorPage(s, {
  registry = () => fixtureRegistry({ sok: join(dirname(s.app.binary), "sok"), plugin: FLOOR_PAGE.folder }),
  applied = pluginChange,
  remove = (folder) => rmSync(folder, { recursive: true, force: true }),
} = {}) {
  const { plugin } = FLOOR_PAGE;
  const before = await s.get("core.plugins");
  const folder = registry();
  s.cleanup(() => remove(folder));
  s.cleanup(async () => {
    if ((await s.get("core.plugins")).plugins.find((row) => row.id === plugin)?.installed) {
      await applied(s, () => s.run("core.plugins.remove", { plugin }), `the removal of ${plugin} in the cleanup`);
    }
    await s.run("core.plugins.registry", { index: before.registry });
  });
  await s.run("core.plugins.registry", { index: pathToFileURL(join(folder, "index.json")).href });
  await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === plugin), `the fixture registry did not list ${plugin}`);
  await applied(s, () => s.run("core.plugins.install", { plugin }), `the install of ${plugin}`);
  const { tab } = await s.run("core.card.add-tab", { card: "terminal", plugin });
  s.cleanup(() => s.run("core.tab.close", { tab }));
  await s.until("core.grid", (grid) => grid.cards.find((card) => card.id === "terminal")?.active === tab,
    `the floor page tab ${tab} is not the active tab of the terminal card`);
  await s.until("core.surfaces", (surfaces) => surfaces.some((row) => row.surface === tab && row.status.phase === "ready"),
    `the floor page view ${tab} did not declare its composition`);
  return tab;
}
