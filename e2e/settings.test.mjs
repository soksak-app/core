// Checks the pages of the settings tab (Workspace, Sets, Installed plugins and plugin pages), creating, editing and deleting a set, and setting the layout values (docs/spec/settings.md).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows } from "@soksak/window-check/event-log.mjs";
import { cardSidebar, fresh, settingsShown } from "./fixture.mjs";

/** The second layout probe: a plugin without settings, sections or sidebar defaults beside the start plugin. */
const SECOND = "layoutprobe2";
/** The sections of the inset card sidebar that the checks put on the start card. */
const CARD_SECTIONS = ["layoutprobe.alpha", "layoutprobe.beta"];
/** The card of the grid that holds the tab surface. */
const cardOf = (grid, surface) => grid.cards.find((item) => item.tabs?.some((tab) => tab.tab === surface)).id;

/** Current controls of the settings tab. */
const controls = async (s) => (await s.get("core.settings-tab")).controls;

/** The menu elements of the settings tab, which are not controls of a page. */
const MENU_NAMES = ["core.settings-tab.nav", "core.settings-tab.scope", "core.settings-tab.close", "core.settings-tab.pane",
  "core.settings-tab.find", "core.settings-tab.plugin-item", "core.settings-tab.badge", "core.settings-tab.chip"];

/** Waits until the control is found by name and key. */
async function control(s, name, key) {
  const tab = await s.until("core.settings-tab",
    (value) => value.controls.some((c) => c.name === name && c.key === key), `settings control ${name} ${key} did not appear`);
  return tab.controls.find((c) => c.name === name && c.key === key);
}

/** Waits until a control of the settings tab has key, whichever element it is. */
async function hasControl(s, key) {
  await s.until("core.settings-tab", (value) => value.controls.some((c) => c.key === key), `settings control ${key} did not appear`);
}

/** Runs the command that the control points to. If value is present, it is sent as a value input. */
async function press(s, name, key, value, param = "value") {
  const found = await control(s, name, key);
  assert.ok(found.command, `${name} ${key} has no command`);
  const params = { ...found.command.params };
  if (value !== undefined) params[param] = value;
  return s.run(found.command.name, params);
}

/** Shows a page of the settings tab (docs/spec/settings.md#menu). */
async function section(s, page) {
  await press(s, "core.settings-tab.nav", `nav:${page}`);
  await s.until("core.settings-tab", (tab) => tab.page === page, `settings did not show ${page}`);
}

/** Runs the command of the first control of name whose command params match, with value set on param. */
async function pressWhere(s, name, match, value, param) {
  const { controls } = await s.until("core.settings-tab", (tab) => tab.controls.some((c) => c.name === name && match(c)),
    `settings control ${name} did not appear`);
  const found = controls.find((c) => c.name === name && match(c));
  const params = { ...found.command.params };
  if (value !== undefined) params[param] = value;
  await s.run(found.command.name, params);
}

const settingsValue = async (s, key) => (await s.get("core.settings")).values[key];

for (const app of Object.values(APPS)) {
  test(`${app.name}: card sidebar choices of a plugin persist through declared controls and reload`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { plugin } = await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await section(s, "installed");
    await press(s, "core.settings-tab.plugin", `plugin:${plugin}`);
    const set = (await settingsValue(s, "sets"))[0].id;
    const places = ["card-left", "card-right", "card-top", "card-bottom"];
    for (const place of places) {
      await press(s, "core.settings-tab.link", `link:${place}:${plugin}`, set, "set");
      await s.until("core.settings", (state) => !state.saving && state.values.links.some((link) =>
        link.place === place && link.plugin === plugin && link.set === set), `${place} was not saved`);
    }
    const persisted = JSON.parse(readFileSync(join(app.configDir, "settings.json"), "utf8"));
    assert.deepEqual(persisted.links.filter((link) => link.plugin === plugin && places.includes(link.place))
      .map((link) => [link.place, link.set]), places.map((place) => [place, set]));
    await s.run("core.settings.close");
    const before = (await s.get("core.window.workbench")).start;
    await s.run("host.window.reload");
    await s.until("core.window.workbench", (workbench) => workbench.start !== before && workbench.readyState === "complete",
      "the workbench did not start again");
    const restored = await s.until("core.settings", (state) => places.every((place) => state.values.links.some((link) =>
      link.place === place && link.plugin === plugin && link.set === set)), `reload lost the ${plugin} card sidebar choices`);
    assert.equal(restored.saving, false);
  });

  test(`${app.name}: settings keep sidebar appearance in the workspace page and list plugins with search and pages`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { plugin } = await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    const opened = await s.until("core.settings-tab", (tab) => tab !== null, "settings did not open");
    const navs = opened.controls.filter((c) => c.name === "core.settings-tab.nav").map((c) => c.key);
    assert.deepEqual(navs, ["nav:look", "nav:workspace", "nav:sets", "nav:behavior", "nav:agents", "nav:diag",
      "nav:installed", "nav:browse"]);

    // Workspace: the sidebar choices and sizes are here and plugin settings are not.
    await section(s, "workspace");
    await hasControl(s, "left");
    await hasControl(s, "right");
    await hasControl(s, "link:left:");
    for (const key of ["sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth"]) {
      await hasControl(s, key);
    }
    const pluginKeys = Object.keys((await s.get("core.settings")).values).filter((key) => key.includes("."));
    const workspace = (await controls(s)).map((c) => c.key ?? "");
    assert.deepEqual(workspace.filter((key) => pluginKeys.includes(key)), [], "작업 공간 shows plugin settings");

    // Sets: only the set list and a new set are here.
    await section(s, "sets");
    const sets = (await controls(s)).filter((c) => !MENU_NAMES.includes(c.name)).map((c) => c.name);
    assert.deepEqual([...new Set(sets)].sort(),
      ["core.settings-tab.create", "core.settings-tab.delete", "core.settings-tab.edit"]);

    // Plugins: a search field and a list. The search term filters the list, a row opens a page, and the list returns.
    await section(s, "installed");
    const list = await s.until("core.settings-tab", (tab) => tab.plugin === null && tab.listed.length > 0,
      "the plugin list did not show");
    // The list holds the enabled installed plugins of the configuration, in the order of their ids.
    const { plugins: installed } = JSON.parse(readFileSync(join(s.app.configDir, "plugins", "installed.json"), "utf8"));
    assert.deepEqual(list.listed, Object.keys(installed).filter((id) => installed[id].enabled).sort());
    assert.equal(list.query, "");
    const rows = list.controls.filter((c) => c.name === "core.settings-tab.plugin-row");
    assert.deepEqual(rows.map((c) => c.command?.params?.plugin), list.listed);
    // A row shows only the plugin name. The description and the install actions are on the plugin page of the settings tab (docs/spec/settings.md).
    const names = Object.fromEntries((await s.get("core.plugins")).plugins.map((row) => [row.id, row.name]));
    assert.deepEqual(rows.map((c) => c.label), list.listed.map((id) => names[id]));
    // The search ignores case: the term matches the id of the second probe and no other id, name or description.
    await s.run("core.settings-tab.search", { query: SECOND.toUpperCase() });
    await s.until("core.settings-tab", (tab) => tab.query === SECOND.toUpperCase() && tab.listed.join() === SECOND,
      `the search did not keep only ${SECOND}`);
    await s.run("core.settings-tab.search", { query: "없는플러그인" });
    await s.until("core.settings-tab", (tab) => tab.listed.length === 0, "a query without a match still lists plugins");
    await s.run("core.settings-tab.search", { query: "" });
    await s.until("core.settings-tab", (tab) => tab.listed.join() === list.listed.join(), "an empty query did not list every plugin");

    await press(s, "core.settings-tab.plugin", `plugin:${plugin}`);
    const page = await s.until("core.settings-tab", (tab) => tab.plugin === plugin, `the ${plugin} page did not open`);
    assert.deepEqual(page.listed, [], "the page still shows the plugin list");
    // There is one row per setting that the manifest declares, in the declaration order. The default values of the plugin settings are registered in that order.
    const declared = Object.keys((await s.get("core.settings")).values).filter((key) => key.startsWith(`${plugin}.`));
    assert.deepEqual(page.rows.map((row) => row.key), declared, `${plugin} rows: ${JSON.stringify(page.rows)}`);
    const shadeKey = `${plugin}.shade`;
    assert.deepEqual(page.rows.find((row) => row.key === shadeKey), {
      key: shadeKey, name: "Shade", description: "A choice that the probe reports.",
    });
    await control(s, "core.settings-tab.link", `link:window-right:${plugin}`);
    for (const side of ["left", "right", "top", "bottom"]) {
      assert.equal((await control(s, "core.settings-tab.link", `link:card-${side}:${plugin}`)).value, "off",
        `the missing card-${side} link did not display off`);
    }
    // A choice is a select box regardless of the number of values (Controls in docs/spec/settings.md).
    const shade = await control(s, "core.settings-tab.set", shadeKey);
    assert.deepEqual(shade.options, ["plain", "strong"]);
    await press(s, "core.settings-tab.set", shadeKey, "strong");
    await s.until("core.settings", (value) => value.values[shadeKey] === "strong" && !value.saving,
      `the plugin page did not change ${shadeKey}`);
    await s.run("core.settings-tab.back");
    await s.until("core.settings-tab", (tab) => tab.plugin === null && tab.listed.join() === list.listed.join(), "목록 did not return to the list");
  });

  test(`${app.name}: the settings plugin page has no plugin operation and the Manage plugins control shows the installed plugins`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { plugin } = await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(async () => {
      if ((await s.get("core.settings-tab")) !== null) await s.run("core.settings.close");
    });
    await section(s, "installed");
    await press(s, "core.settings-tab.plugin", `plugin:${plugin}`);
    const page = await s.until("core.settings-tab", (tab) => tab.plugin === plugin, `the ${plugin} page did not open`);
    assert.deepEqual(page.controls.filter((c) => c.command?.name.startsWith("core.plugins.")), [],
      "the settings plugin page still runs plugin operations");
    await s.run("core.settings-tab.back");
    await s.until("core.settings-tab", (tab) => tab.plugin === null, "the back link did not return to the list");
    await s.run("core.plugins.browse");
    await s.until("core.settings-tab", (tab) => tab.page === "installed" && tab.listed.includes(plugin),
      "플러그인 관리 did not show the installed plugins");
  });

  test(`${app.name}: settings create, edit with section rows, and delete a sidebar set`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await s.until("core.settings-tab", (tab) => tab !== null, "settings did not open");
    await section(s, "sets");
    const before = await settingsValue(s, "sets");

    await pressWhere(s, "core.settings-tab.create", () => true);
    const created = await s.until("core.settings", (value) => value.values.sets.length === before.length + 1 && !value.saving,
      "새 세트 did not add a set");
    const made = created.values.sets.at(-1);
    assert.deepEqual({ title: made.title, layout: made.layout, sections: made.sections },
      { title: "새 세트", layout: "list", sections: [] });
    await s.until("core.settings-tab", (tab) => tab.editing === made.id, "the new set is not being edited");

    await pressWhere(s, "core.settings-tab.set-title", (c) => c.command?.params?.id === made.id, "검사 세트", "title");
    await pressWhere(s, "core.settings-tab.layout", (c) => c.command?.params?.id === made.id && c.command?.params?.layout === "tabs");
    const sectionsOf = async () => (await settingsValue(s, "sets")).find((item) => item.id === made.id).sections;
    const saved = (want, message) => s.until("core.settings", (value) => !value.saving &&
      value.values.sets.find((item) => item.id === made.id)?.sections.join() === want.join(), message);

    // The section select adds the chosen registered section and appends it to the set (docs/spec/settings.md#stored-sets-and-links).
    const addControl = (await s.get("core.settings-tab")).controls.find((c) => c.name === "core.settings-tab.add");
    const registered = addControl.groups.flatMap((g) => g.values);
    assert.equal(registered.length, 5, "the layout probe and the plain view probe declare five sections");
    assert.deepEqual(addControl.groups.map((g) => g.label), ["Layout probe", "Plain view probe"]);
    const three = registered.slice(0, 3);
    for (const [index, section] of three.entries()) {
      await pressWhere(s, "core.settings-tab.add", () => true, section, "section");
      await s.until("core.settings", (value) => !value.saving &&
        value.values.sets.find((item) => item.id === made.id)?.sections.length === index + 1, `the add select did not append ${section}`);
    }
    assert.deepEqual(await sectionsOf(), three);
    // Each chip has its × (remove with its index) and the editor has one section select.
    const rowsShown = await s.until("core.settings-tab", (tab) =>
      tab.controls.filter((c) => c.name === "core.settings-tab.row-act").length === 3, "the editor did not draw three section chips");
    assert.equal(rowsShown.controls.filter((c) => c.name === "core.settings-tab.add").length, 1);
    assert.deepEqual(rowsShown.controls.filter((c) => c.name === "core.settings-tab.row-act")
      .map((c) => `${c.command.params.action}:${made.id}:${c.command.params.index}`), [
      `remove:${made.id}:0`, `remove:${made.id}:1`, `remove:${made.id}:2`,
    ]);

    await pressWhere(s, "core.settings-tab.row-act", (c) => c.command?.params?.index === 1);
    await saved([three[0], three[2]], "× did not remove the section at index 1");
    // A section that the set already holds is rejected, and the rejected change leaves the set as it was.
    await assert.rejects(pressWhere(s, "core.settings-tab.add", () => true, three[0], "section"),
      new RegExp(`section ${three[0].replaceAll(".", "\\.")} is already in set ${made.id}`));
    assert.deepEqual(await sectionsOf(), [three[0], three[2]], "a rejected repeat changed the set");

    await s.run("core.settings-tab.edit", { set: null });
    await s.until("core.settings-tab", (tab) => tab.editing === null, "완료 did not close the editor");
    await s.run("core.settings.link", { place: "left", plugin: null, set: made.id, scope: "common" });
    await s.until("core.settings", (value) => !value.saving && value.values.links.some((l) => l.set === made.id),
      "the set was not linked");
    await pressWhere(s, "core.settings-tab.delete", (c) => c.command?.params?.id === made.id);
    await pressWhere(s, "core.settings-tab.confirm-yes", (c) => c.command?.params?.id === made.id);
    const deleted = await s.until("core.settings", (value) => !value.saving && !value.values.sets.some((item) => item.id === made.id),
      "삭제 did not remove the set");
    assert.ok(!deleted.values.links.some((l) => l.set === made.id), "deleting the set kept its link");
  });

  test(`${app.name}: layout value settings change the inset sidebar widths`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await cardSidebar(s, { sections: CARD_SECTIONS });
    await s.run("core.settings.set", { patch: { sidebarWidth: 150, sidebarMinWidth: 140 }, scope: "common" });
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left?.size === 150),
      "an internal card sidebar did not open at sidebarWidth");
    const card = grid.cards.find((item) => item.sidebars?.left);
    await assert.rejects(s.run("core.card.sidebar.size", { card: card.id, side: "left", size: 130 }), /140 to 480/);
    await assert.rejects(s.run("core.settings.set", { patch: { sidebarMinWidth: 200 }, scope: "common" }),
      /sidebarMinWidth .*sidebarWidth .*sidebarMaxWidth/);
  });

  test(`${app.name}: an invalid stored set or link is rejected when it is changed and when it is loaded`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await keepCommonSettings(s);
    const sets = await settingsValue(s, "sets");
    // A section that the loaded layout probe does not declare is rejected.
    const broken = sets.map((item, index) => (index === 0 ? { ...item, sections: [...item.sections, "layoutprobe.gone"] } : item));
    await assert.rejects(s.run("core.settings.set", { patch: { sets: broken }, scope: "common" }),
      /names unknown section layoutprobe\.gone/);
    await assert.rejects(s.run("core.settings.set", { patch: { links: [{ place: "left", plugin: null, set: "set-none" }] }, scope: "common" }),
      /known set/);
    assert.deepEqual(await settingsValue(s, "sets"), sets, "a rejected change altered the sets");
    // A section of a plugin that is not loaded stays in the set (docs/spec/plugins.md).
    const kept = sets.map((item, index) => (index === 0 ? { ...item, sections: [...item.sections, "gone.section"] } : item));
    await s.run("core.settings.set", { patch: { sets: kept }, scope: "common" });
    assert.deepEqual(await settingsValue(s, "sets"), kept, "a set naming a section of a plugin that is not loaded was not kept");
    await s.run("core.settings.set", { patch: { sets }, scope: "common" });

    // If a set holds a section that is not registered in the project settings file, the command that opens that project is rejected with that error.
    // The caller that received the rejection reports the failure once (docs/spec/settings.md).
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-sets-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".soksak"), { recursive: true });
    writeFileSync(join(root, ".soksak/settings.json"), JSON.stringify({ format: 1, sets: broken }));
    // The invalid set that this check saved is also reported as a page error every time the settings of that project are reloaded.
    s.expectError(/settings: set .* names unknown section layoutprobe\.gone/);
    await s.run("core.settings.set", { patch: { projectOpening: "tabs" }, scope: "common" });
    const opened = s.run("core.project.open", { root, color: "#7fe3b0" }).catch((error) => error);
    s.cleanup(async () => {
      for (const item of await s.get("core.projects")) {
        if (item.root === root) await s.run("core.project.close", { id: item.id });
      }
    });
    const refused = await opened;
    assert.ok(refused instanceof Error, "opening a project with an invalid stored set did not fail");
    assert.match(refused.message, /settings: set .* names unknown section layoutprobe\.gone/);
  });

  test(`${app.name}: a plugin's right sidebar choice takes precedence over the general choice`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { surface, plugin } = await fresh(s);
    await keepCommonSettings(s);
    // The start card shows the start plugin and the other card of the start layout a tab of the second probe.
    const grid = await s.get("core.grid");
    const own = cardOf(grid, surface);
    const other = grid.cards.find((card) => card.id !== own && card.tabs?.length > 0)?.id;
    assert.ok(other, "the start layout has no second card with tabs");
    const { tab: second } = await s.run("core.card.add-tab", { card: other, plugin: SECOND });
    s.cleanup(() => s.run("core.tab.close", { tab: second }));
    // Three stored sets of probe sections: the override of each plugin and the general choice.
    const stored = await settingsValue(s, "sets");
    const ownSet = { id: "check-own", title: "Own", sections: ["layoutprobe.alpha"], layout: "list" };
    const generalSet = { id: "check-general", title: "General", sections: ["layoutprobe.beta"], layout: "list" };
    const secondSet = { id: "check-second", title: "Second", sections: ["layoutprobe.fill"], layout: "list" };
    await s.run("core.settings.set", { patch: { sets: [...stored, ownSet, generalSet, secondSet] }, scope: "common" });
    const right = async (card, want, message) => {
      await s.run("core.card.focus", { card });
      await s.until("core.sidebars", (bars) => (bars.find((bar) => bar.sidebar === "right")?.set ?? null) === want, message);
    };
    // A general choice is place right and a plugin override is place window-right. off removes that connection.
    const general = (set) => s.run("core.settings.link", { place: "right", plugin: null, set, scope: "common" });
    const override = (owner, set) => s.run("core.settings.link", { place: "window-right", plugin: owner, set, scope: "common" });
    // The default has no general choice. An override is placed on the start plugin.
    await override(plugin, ownSet.id);
    await right(own, ownSet.id, `the ${plugin} override did not show while no general choice exists`);
    // Even if a general set exists, the override of the focused plugin takes precedence.
    await general(generalSet.id);
    await right(own, ownSet.id, `the general set replaced the ${plugin} override`);
    // Removing the override reveals the general set.
    await override(plugin, "off");
    await right(own, generalSet.id, `removing the ${plugin} override did not show the general set`);
    await override(SECOND, secondSet.id);
    await right(other, secondSet.id, `the ${SECOND} override did not take precedence over the general set`);
    await assert.rejects(general("inherit"), /inherit/);
    await assert.rejects(override(SECOND, "inherit"), /inherit/);
  });

  test(`${app.name}: a card-left link draws an internal card sidebar and no rail column`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await cardSidebar(s, { sections: CARD_SECTIONS });
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left),
      "no card holds an internal sidebar after a card-left link");
    assert.equal(grid.cards.some((card) => card.id.startsWith("rail-")), false, "a rail column stands in a fresh configuration");
    // There is no position setting for the card sidebar. There are only the fixed window sidebar and the sidebar inside the card.
    assert.equal(Object.hasOwn((await s.get("core.settings")).values, "cardSidebar"), false);
    await assert.rejects(s.run("core.settings.set", { patch: { cardSidebar: "inset" }, scope: "common" }), /Unknown setting: cardSidebar/);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await section(s, "general");
    assert.deepEqual((await controls(s)).filter((c) => c.key === "cardSidebar"), [], "일반 shows a card sidebar position");
  });

  test(`${app.name}: performance tracing records enabled card focus and stops while disabled`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    // The events of the trace are stored in the class call at the level debug, which the default policy does not store.
    await fresh(s, { log: { call: "debug" }, reads: ["workbench.trace.action", "host.trace.on", "host.trace.off"] });
    await keepCommonSettings(s);
    // The host uses the path in which the symbolic link of the configuration directory is resolved.
    const config = realpathSync(app.configDir);
    const services = join(config, "services");
    // The process of the host holds the switch: the switch writes no file of the configuration folder and no flag into a
    // service directory (docs/spec/performance-trace.md#the-switch). A file that an earlier build left stays as it was.
    const switchFiles = () => Object.fromEntries([join(config, "performance"), join(config, "logs", "performance.ndjson"),
      ...(existsSync(services) ? readdirSync(services, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => join(services, entry.name, "performance")) : [])]
      .filter((path) => existsSync(path)).map((path) => [path, statSync(path).mtimeMs]));
    // The events of the trace of the page and of the host are in the event log. The switch controls the events below; the
    // entrances that always record (host.endpoint.call, host.test.mark) and a sidecar, which stores its events in its own
    // file whether or not the trace is on (docs/spec/performance-trace.md), are not output of the switch.
    const SWITCHED = ["workbench.trace.", "host.trace.", "host.sampler."];
    const traced = async (offsets) => {
      await s.flushLog();
      const switched = readEvents(config, offsets).events.filter((event) =>
        SWITCHED.some((prefix) => event.event.startsWith(prefix)));
      return traceRows(switched);
    };
    const change = (enabled) => s.run("core.settings.set", {
      scope: "common", patch: { "diagnostics.performance": enabled },
    });
    await change(false);
    const files = switchFiles();
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.length).id;
    const before = currentEventOffsets(config);
    await s.run("core.card.focus", { card });
    assert.deepEqual(await traced(before), [], "disabled focus changed the trace output");
    await change(true);
    assert.deepEqual(switchFiles(), files, "enabling the trace wrote a file or a service flag");
    await s.run("core.card.focus", { card });
    await change(false);
    assert.deepEqual(switchFiles(), files, "disabling the trace wrote a file or a service flag");
    const events = await traced(before);
    const after = currentEventOffsets(config);
    assert.ok(events.some((line) => line.layer === "workbench" && line.event === "action"
      && line.kind === "card.focus" && line.card === card), "enabled focus action was not recorded");
    assert.ok(events.some((line) => line.layer === "workbench" && line.event === "command"
      && line.name === "core.card.focus" && line.ok === true), "enabled focus command was not recorded");
    await s.run("core.card.focus", { card });
    assert.deepEqual(await traced(after), [], "focus after disable changed the trace output");
  });

  test(`${app.name}: a new inset sidebar opens at 190 points`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    await cardSidebar(s, { sections: CARD_SECTIONS });
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left),
      "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebars?.left);
    assert.equal(card.sidebars.left.size, 190);
    assert.equal(card.sidebars.left.collapsed, false);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a settings change keeps the scroll position of the window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const dim = (await s.get("core.settings")).values.dim;
    s.cleanupSteps(
      async () => {
        await s.run("core.settings.set", { patch: { dim }, scope: "common" });
      },
      async () => {
        await s.run("core.settings.close");
      },
    );
    await s.run("core.settings.open");
    await s.until("core.settings-tab", (tab) => tab !== null && tab.scroll === 0, "the settings tab did not open at its top");
    const box = await s.rect("core.settings-tab.pane");
    const card = { x: (box.document?.x ?? 0) + box.x, y: (box.document?.y ?? 0) + box.y, w: box.width, h: box.height };
    // The wheel goes to the displayed settings tab. A wheel before the display goes to the workbench behind it.
    await settingsShown(s, "the settings tab was not shown");
    // Scrolls the General section down. The native window reports the position.
    await s.pointer(card.x + card.w / 2, card.y + card.h / 2, "scroll", { deltaY: 240 });
    const { scroll } = await s.until("core.settings-tab", (tab) => tab.scroll > 0, "the settings pane did not scroll");
    // Changing a value redraws the window. The content stays the same after the redraw, so the position is kept.
    const drawn = await s.collect("core.settings-tab");
    await s.run("core.settings.change", { key: "dim", value: String(!dim), scope: "common" });
    await s.until("core.settings", (value) => value.values.dim === !dim && !value.saving, "the setting did not change");
    await s.presented();
    const seen = (await drawn.stop()).map((modal) => modal.scroll);
    assert.deepEqual(seen.filter((value) => value !== scroll), [],
      `the settings pane moved from ${scroll} while it redrew: ${JSON.stringify(seen)}`);
  });
}
