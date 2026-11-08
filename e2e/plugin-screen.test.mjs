// The plugin page of the library: checks the description, the version, the sidecars, the search and the plugin actions (Plugin screen in docs/spec/installation.md).
// The page lists the fixture plugins of the check application (scripts/fixture-registry.mjs): the raster probe uses the fake sidecar
// rasterprobe, the plain-view probe is the plugin that the checks disable and enable, and the save-close probe gives the modified tab.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { fixturePluginIds } from "../scripts/fixture-registry.mjs";
import { fresh, pluginChangeApplied } from "./fixture.mjs";

/** The fixture plugin that uses a fake sidecar. */
const SIDECAR_PLUGIN = "rasterprobe";
/** The fixture plugin that the checks disable and enable; no start tab shows it. */
const PLUGIN = "probeplain";
/** The fixture plugin whose tab reports itself modified and declares a save command. */
const MODIFIED_PLUGIN = "probeclose";

/** Shows the plugin page and, when the check ends, returns to the project page and the work screen. */
async function showPlugins(s) {
  s.cleanup(async () => {
    if ((await s.get("core.screen")).screen !== "library") return;
    await s.run("core.library.plugins.search", { query: "" });
    await s.run("core.library.page", { page: "projects" });
    await s.run("core.library.return");
  });
  await s.run("core.plugins.browse");
  await s.until("core.screen", (screen) => screen.screen === "library", "core.plugins.browse did not show the library");
  return s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.length > 0,
    "the plugin page did not list plugins");
}

/**
 * Runs `change`, a plugin change that starts the workbench of the window again, and returns core.window.workbench of the new start.
 * The command answers before the new start (docs/spec/installation.md#applying-a-change), and the old document ends without
 * replying to a request that reaches it, so the wait reads the start from the event log (pluginChangeApplied) and not from the
 * status of the window.
 */
async function startedAgain(s, change, action) {
  const before = (await s.get("core.window.workbench")).start;
  const offsets = currentEventOffsets(s.app.configDir);
  const result = await change();
  await pluginChangeApplied(s, offsets, action);
  const workbench = await s.get("core.window.workbench");
  assert.notEqual(workbench.start, before, `${action} did not start the workbench again`);
  assert.equal(workbench.readyState, "complete");
  return { workbench, result };
}

/** Returns the action names of the visible plugin cards in document order. */
const actionsOf = (library, plugin) => library.plugins.actions.filter((item) => item.plugin === plugin).map((item) => item.action);

for (const app of Object.values(APPS)) {
  test(`${app.name}: the library plugin page lists plugins with descriptions, versions and sidecars`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const library = await showPlugins(s);
    const plugins = await s.get("core.plugins");
    assert.deepEqual(library.plugins.shown, plugins.plugins.map((row) => row.id));
    assert.deepEqual(library.plugins.shown, fixturePluginIds().toSorted());
    for (const row of plugins.plugins) {
      assert.ok(row.description.length > 0, `${row.id} shows no description`);
      assert.ok(row.installed?.version, `${row.id} shows no installed version: ${JSON.stringify(row)}`);
    }
    const user = plugins.plugins.find((row) => row.id === SIDECAR_PLUGIN);
    assert.ok(user.sidecars.length > 0, `${SIDECAR_PLUGIN} lists no sidecar: ${JSON.stringify(user)}`);
    assert.ok(user.sidecars.every((sidecar) => typeof sidecar.version === "string"),
      `a ${SIDECAR_PLUGIN} sidecar has no installed version: ${JSON.stringify(user.sidecars)}`);
    // The card offers the update action only when the registry lists a version newer than the installed one.
    const update = plugins.updates.some((item) => item.id === PLUGIN) ? ["update"] : [];
    assert.deepEqual(actionsOf(library, PLUGIN), [...update, "disable", "remove"]);

    await s.run("core.library.plugins.search", { query: "RASTER" });
    await s.until("core.library", (value) => value.plugins.query === "RASTER" && value.plugins.shown.join() === SIDECAR_PLUGIN,
      `the plugin search did not keep only ${SIDECAR_PLUGIN}`);
    await s.run("core.library.plugins.search", { query: "없는플러그인" });
    await s.until("core.library", (value) => value.plugins.shown.length === 0, "a query without a match still lists plugins");
    await s.run("core.library.plugins.search", { query: "" });
    await s.until("core.library", (value) => value.plugins.shown.join() === library.plugins.shown.join(),
      "an empty query did not list every plugin");

    // The project list command shows the project page.
    await s.run("core.library.return");
    await s.until("core.screen", (screen) => screen.screen === "workspace", "the library did not return to the workspace");
    await s.run("core.projects.browse");
    await s.until("core.library", (value) => value.page === "projects" && value.plugins.shown.length === 0 && value.shown.length > 0,
      "core.projects.browse did not show the project page");
  });

  test(`${app.name}: a plugin card disables and enables an installed plugin and the window applies each change`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    // Turns the plugin on again so that the next check starts from the same installation even if a check fails midway.
    s.cleanup(async () => {
      const now = (await s.get("core.plugins")).plugins.find((row) => row.id === PLUGIN);
      if (!now.installed.enabled) await s.run("core.plugins.enable", { plugin: PLUGIN });
    });
    await showPlugins(s);
    const listed = await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === PLUGIN),
      `core.plugins did not list ${PLUGIN}`);
    assert.equal(listed.plugins.find((row) => row.id === PLUGIN).state, "loaded");
    assert.equal(listed.reload, false);

    // A plugin operation starts the workbench of the window again, which then reports the change without an application restart
    // (docs/spec/installation.md#applying-a-change). Each reload is a new start of the workbench.
    assert.ok(actionsOf(await s.get("core.library"), PLUGIN).includes("disable"), `the ${PLUGIN} card has no 사용 안 함`);
    await startedAgain(s, () => s.run("core.plugins.disable", { plugin: PLUGIN }), `disabling ${PLUGIN}`);
    const disabled = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === PLUGIN)?.state === "disabled",
      `the reloaded window did not report ${PLUGIN} disabled`);
    assert.equal(disabled.reload, false);
    assert.equal(disabled.plugins.find((row) => row.id === PLUGIN).installed.enabled, false);

    await showPlugins(s);
    await s.until("core.library", (value) => actionsOf(value, PLUGIN).includes("enable"), `the ${PLUGIN} card did not offer 사용`);
    await startedAgain(s, () => s.run("core.plugins.enable", { plugin: PLUGIN }), `enabling ${PLUGIN}`);
    const enabled = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === PLUGIN)?.state === "loaded",
      `the reloaded window did not load ${PLUGIN}`);
    assert.equal(enabled.reload, false);
    await assert.rejects(s.run("core.plugins.enable", { plugin: "" }), /plugin must be a non-empty string/);
  });

  test(`${app.name}: a plugin change asks about a modified tab before it reloads the window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const start = async () => (await s.get("core.window.workbench")).start;
    const tabOf = (grid, id) => grid.cards.flatMap((card) => card.tabs ?? []).find((tab) => tab.id === id);

    // The save-close probe reports its tab modified and counts each call of its save command, across a new start of the workbench.
    const card = (await s.get("core.grid")).cards.find((item) => item.focused);
    const { tab: surface } = await s.run("core.card.add-tab", { card: card.id, plugin: MODIFIED_PLUGIN });
    s.cleanup(async () => {
      if (!tabOf(await s.get("core.grid"), surface)) return;
      const { closed } = await s.run("core.tab.close", { tab: surface });
      if (closed) return;
      const picker = await s.until("core.picker", (value) => value.open, "the close question did not open");
      await s.run("core.picker.pick", { index: picker.items.findIndex((item) => item.name === "저장하지 않고 닫기") });
    });
    await s.until("core.surfaces", (all) => all.some((x) => x.surface === surface && x.status.phase === "ready"), `the ${MODIFIED_PLUGIN} tab did not open`);
    await s.registered(surface, [`command ${MODIFIED_PLUGIN}.prepare`, `command ${MODIFIED_PLUGIN}.save`, `status ${MODIFIED_PLUGIN}.state`]);
    await s.run(`${MODIFIED_PLUGIN}.prepare`, { keepModified: true }, surface);
    await s.until("core.grid", (grid) => tabOf(grid, surface)?.modified === true, `${MODIFIED_PLUGIN}.prepare did not make the tab modified`);
    assert.deepEqual(await s.get(`${MODIFIED_PLUGIN}.state`, surface), { saves: 0, modified: true });

    // The plain-view probe is enabled again after the check, which reloads the window once more.
    s.cleanup(async () => {
      if ((await s.get("core.plugins")).plugins.find((row) => row.id === PLUGIN).installed.enabled) return;
      await startedAgain(s, () => s.run("core.plugins.enable", { plugin: PLUGIN }), `enabling ${PLUGIN}`);
    });
    const before = await start();
    await s.run("core.plugins.disable", { plugin: PLUGIN });
    const ask = async () => (await s.until("core.picker", (picker) => picker.open && picker.title.includes("저장하지 않은 변경이 있습니다"),
      "the plugin change did not ask about the modified tab")).items.map((item) => item.name);
    assert.deepEqual(await ask(), ["저장하고 적용", "저장하지 않고 적용", "적용하지 않기"]);
    // The action that declines to apply keeps the page, and the card offers to apply the change.
    await s.run("core.picker.pick", { index: 2 });
    const kept = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === PLUGIN).state === "reload",
      `적용하지 않기 did not leave the ${PLUGIN} change waiting for a reload`);
    assert.equal(kept.reload, true);
    assert.equal(await start(), before, "적용하지 않기 reloaded the window");
    assert.deepEqual(await s.get(`${MODIFIED_PLUGIN}.state`, surface), { saves: 0, modified: true }, "적용하지 않기 ran the save command");

    // core.plugins.apply asks again, and the action that applies without saving reloads the window without running the save command.
    const { result: applied } = await startedAgain(s, async () => {
      const applying = s.run("core.plugins.apply", {});
      assert.deepEqual(await ask(), ["저장하고 적용", "저장하지 않고 적용", "적용하지 않기"]);
      await s.run("core.picker.pick", { index: 1 });
      return applying;
    }, "저장하지 않고 적용");
    assert.deepEqual(applied, { reloaded: true });
    const reported = await s.until("core.plugins", (value) => value.plugins.find((row) => row.id === PLUGIN).state === "disabled",
      `the reloaded window did not report ${PLUGIN} disabled`);
    assert.equal(reported.reload, false);
    await s.registered(surface, [`status ${MODIFIED_PLUGIN}.state`]);
    assert.equal((await s.get(`${MODIFIED_PLUGIN}.state`, surface)).saves, 0, "저장하지 않고 적용 ran the save command");
  });
}
