// The floor of the view drag benchmark (docs/operations/examples.md, F502-2 and F502-25): with FLOOR=1 the benchmark drags a card whose
// view page draws one colour and runs no plugin code, so the drag measures the host and the web view alone. The page is the plugin
// floorpage of e2e/fixtures/view-drag/floor-page; its colour is the measurement colour of the terminal geometry
// (TERMINAL_GEOMETRY_BACKGROUND of cases/terminal.mjs), so the geometry rule of the drag reads its view as it reads a terminal view. The
// benchmark installs the plugin from a fixture registry, which holds the fixtures of e2e/fixtures only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { buildFixtureRegistry } from "../../../scripts/fixture-registry.mjs";
import { combineFailures } from "../../../scripts/test-command.mjs";
import { pluginChangeApplied } from "../../fixture.mjs";

/** The floor page plugin: its id and its folder. */
export const FLOOR_PAGE = Object.freeze({
  plugin: "floorpage",
  folder: fileURLToPath(new URL("../../fixtures/view-drag/floor-page/", import.meta.url)),
});

const removeFolder = (folder) => rmSync(folder, { recursive: true, force: true });

/**
 * Resolves with a new registry folder that holds the fixture registry (scripts/fixture-registry.mjs): every plugin of e2e/fixtures
 * packed, the pack fixtures and the index that the `sok registry build` of the executable `sok` writes. `build` writes it under
 * `signal`, each of its commands within the step limit of the fixture registry. A failed build removes the folder with `remove`; when
 * the removal also fails, the build rejects with an AggregateError of both. The caller removes the folder.
 */
export async function fixtureRegistry({ sok, signal, build = buildFixtureRegistry, remove = removeFolder }) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-fixture-registry-"));
  try {
    await build(sok, folder, { signal });
  } catch (error) {
    let cleanupError = null;
    try {
      remove(folder);
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    throw combineFailures(error, cleanupError);
  }
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
 * remove the registry folder. `signal` cancels the build of the fixture registry. `registry()` writes the fixture registry,
 * `applied(s, run, action)` runs a plugin change and waits until it is applied, and `remove(folder)` removes the registry folder.
 */
export async function openFloorPage(s, {
  signal,
  registry = () => fixtureRegistry({ sok: join(dirname(s.app.binary), "sok"), signal }),
  applied = pluginChange,
  remove = (folder) => rmSync(folder, { recursive: true, force: true }),
} = {}) {
  const { plugin } = FLOOR_PAGE;
  const before = await s.get("core.plugins");
  const folder = await registry();
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
