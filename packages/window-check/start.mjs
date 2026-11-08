// The start state of a window check (docs/spec/plugins.md#window-checks-of-a-plugin). diagnostics.fixture opens the new-space
// layout that environment.json of the application declares (workspace.grid); its tabs that name a plugin that the configuration
// does not load open as placeholders. The preparation replaces each such placeholder by a tab of the start plugin of the check in
// the same card and returns the ready tab of the focused card. The start plugin is the start probe that the package ships
// (fixtures/start-probe, START_PROBE), which `soksak-test-app` installs in every run, unless a check names another fixture plugin
// that its run installs, with the entries that its tab registers when it is ready. A check of a plugin whose start state holds a
// tab of that plugin names it in `addPluginTab`.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepCommonSettings, prepareFixture, TRACE } from "./app.mjs";
import { recordCatalog } from "./catalog.mjs";
import { currentEventOffsets, readEvents, traceRows } from "./event-log.mjs";

/** The start probe that the package ships in fixtures/start-probe; its view reports the status `<id>.view` `{started: true}`. */
export const START_PROBE = "startprobe";

/** The entries that a tab of the start probe has registered when it is ready. */
export const START_PROBE_ENTRIES = Object.freeze([`status ${START_PROBE}.view`]);

/** The id of the common set that cardSidebar stores for `sections` when the check names no set. */
export const CHECK_SET = "check-sections";

/** The declaration `{ catalog, records }` of a wait of `untilEventLines` on the records that the predicate reads. */
export const reading = (app, records) => ({ catalog: recordCatalog(app.configDir), records });

/**
 * The tabs of the layout `grid` (core.grid) that `surfaces` (core.surfaces) report as placeholders, the tabs of plugins that are not
 * loaded, as `{card, tab, plugin}` in the order of the cards and their tabs.
 */
export function placeholderTabs(grid, surfaces) {
  const placeholders = new Set(surfaces.filter((row) => row.kind === "tab" && row.placeholder != null).map((row) => row.surface));
  return (grid?.cards ?? []).flatMap((card) => (card.tabs ?? []).filter((tab) => placeholders.has(tab.id))
    .map((tab) => ({ card: card.id, tab: tab.id, plugin: tab.plugin })));
}

const requirePlugin = (plugin, what) => {
  if (typeof plugin !== "string" || plugin === "") throw new Error(what);
};

/** The entries that a ready start tab of `plugin` has registered when the check names none. */
const entriesOf = (plugin) => (plugin === START_PROBE ? START_PROBE_ENTRIES : []);

/**
 * Replaces every placeholder tab of the start layout by a tab of `plugin` in its card: the new tab is added and activated first,
 * so the card never loses its last tab, and the placeholder tab is closed. Returns the new tabs as `{card, tab}`.
 */
export async function replacePlaceholders(s, plugin = START_PROBE) {
  requirePlugin(plugin, "the start state names no plugin for the tabs that replace the placeholders");
  const added = [];
  for (const { card, tab } of placeholderTabs(await s.get("core.grid"), await s.get("core.surfaces"))) {
    const { tab: opened } = await s.run("core.card.add-tab", { card, plugin });
    await s.run("core.tab.close", { tab });
    added.push({ card, tab: opened });
  }
  return added;
}

/**
 * Waits until the active tab of the focused card is a ready tab of `startPlugin` (START_PROBE by default) that registered
 * `startEntries` (START_PROBE_ENTRIES for the start probe, none for another plugin unless given), and returns it as
 * `{surface, plugin}`. A start layout whose focused card holds no tab of `startPlugin` fails with the grid.
 */
export async function startTab(s, { startPlugin: plugin = START_PROBE, startEntries: entries = entriesOf(plugin) } = {}) {
  requirePlugin(plugin, "the start state names no plugin for its start tab");
  const grid = await s.get("core.grid");
  const focused = grid?.cards.find((card) => card.focused);
  const active = focused?.tabs?.find((tab) => tab.id === focused.active);
  if (active?.plugin !== plugin) {
    throw new Error(`the focused card of the start layout holds no active ${plugin} tab: ${JSON.stringify(grid?.cards ?? null)}`);
  }
  await s.until("core.surfaces", (surfaces) => surfaces.some((row) => row.surface === active.id && row.visible && row.status?.phase === "ready"),
    `the start tab ${active.id} did not become ready`);
  await s.registered(active.id, entries);
  return { surface: active.id, plugin };
}

/**
 * Puts a card-left sidebar on each card whose active tab is a tab of `plugin`. With `sections` it first stores a common set of the
 * layout `layout` (`list` by default) with the id `set` (CHECK_SET by default) that holds those sections, in place of a set with that
 * id, so the sidebar shows them
 * whatever sets the environment of the application declares in place of the sets of the plugins; without `sections` it links the
 * set `set`. keepCommonSettings restores the sets and the links when the
 * check ends. Returns the ids of the card sidebars.
 */
export async function cardSidebar(s, { plugin, set, sections, layout = "list" } = {}) {
  requirePlugin(plugin, "a card sidebar names the plugin of its cards");
  if (set === undefined && sections === undefined) throw new Error("a card sidebar names a set or the sections of its own set");
  const id = set ?? CHECK_SET;
  await keepCommonSettings(s);
  if (sections !== undefined) {
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: [...sets.filter((item) => item.id !== id), { id, title: "검사", sections, layout }] },
      scope: "common" });
  }
  await s.run("core.settings.link", { place: "card-left", plugin, set: id, scope: "common" });
  const cards = (await s.get("core.grid")).cards
    .filter((card) => card.tabs?.find((tab) => tab.id === card.active)?.plugin === plugin).map((card) => `${card.id}:left`);
  if (cards.length === 0) throw new Error(`no card shows an active ${plugin} tab for its card sidebar`);
  await s.until("core.sidebars", (value) => cards.every((sidebar) => value.some((item) => item.sidebar === sidebar && item.set === id)),
    `the card sidebars ${cards.join(", ")} did not show the set ${id}`);
  return cards;
}

/** The surface registration rows of the trace that the event log gained after the offsets. */
async function registrationTimeline(s, offsets) {
  await s.flushLog();
  return traceRows(readEvents(s.app.configDir, offsets).events).filter((row) => row.event === "surface.registration");
}

/** The file of the disposable configuration that holds the registry of the application while a check uses its own registry. */
const heldRegistryFile = (s) => join(s.app.configDir, "check-registry.json");

/**
 * Sets a registry of the check. The first change records the registry that the application had. The record outlives a restore
 * that fails, so the registry of a failed run is never taken for the registry of the application.
 */
export async function useRegistry(s, index) {
  const held = heldRegistryFile(s);
  if (!existsSync(held)) writeFileSync(held, JSON.stringify({ registry: (await s.get("core.plugins")).registry }));
  await s.run("core.plugins.registry", { index });
}

/** Restores the recorded registry and removes the record; without a record the check changed no registry. */
export async function restoreRegistry(s) {
  const held = heldRegistryFile(s);
  if (!existsSync(held)) return;
  await s.run("core.plugins.registry", { index: JSON.parse(readFileSync(held, "utf8")).registry });
  rmSync(held);
}

/**
 * Adds a tab of `plugin` to the focused card, which activates it, and resolves with what `ready(s, tab)` resolves, or with
 * `{surface, plugin}` when it resolves with nothing.
 */
export async function addTabOfPlugin(s, { plugin, ready } = {}) {
  requirePlugin(plugin, "addPluginTab names no plugin");
  if (typeof ready !== "function") throw new Error(`addPluginTab of ${plugin} names no ready function`);
  const grid = await s.get("core.grid");
  const focused = grid?.cards.find((card) => card.focused);
  if (!focused) throw new Error(`the start layout has no focused card: ${JSON.stringify(grid?.cards ?? null)}`);
  const { tab } = await s.run("core.card.add-tab", { card: focused.id, plugin });
  return (await ready(s, tab)) ?? { surface: tab, plugin };
}

/**
 * Replaces every placeholder tab of the start layout by a tab of `placeholderPlugin` (`startPlugin` by default) and returns the
 * active tab of the focused card, a ready tab of `startPlugin` that registered `startEntries` (startTab).
 */
export async function startLayout(s, { startPlugin = START_PROBE, startEntries = entriesOf(startPlugin), placeholderPlugin = startPlugin } = {}) {
  await replacePlaceholders(s, placeholderPlugin);
  return startTab(s, { startPlugin, startEntries });
}

/**
 * Puts the window in the start state of a check and returns the start tab `{surface, plugin}`: diagnostics.fixture opens the
 * new-space layout with `settings`, a registry that an earlier run left is restored, every placeholder tab is replaced by a tab of
 * `placeholderPlugin` (replacePlaceholders; `startPlugin` by default) and the active tab of the focused card is a ready tab of
 * `startPlugin` with `startEntries` (startTab). A plugin that the start layout names itself, which is installed and so opens as no
 * placeholder, is the `startPlugin` of its checks, and the other cards hold tabs of `placeholderPlugin`, for example START_PROBE. With
 * `addPluginTab: {plugin, ready}` a tab of `plugin` is then added to the focused card and the start state waits for
 * `ready(s, tab)`; the result holds what it resolves with as `pluginTab`. Without it no tab of the plugin under check exists.
 * `log` is the log policy that the check declares and `reads` the records below `error` that it reads (prepareFixture); with the
 * performance trace the registration timeline of a failed start is read too.
 */
export async function fresh(s, { startPlugin = START_PROBE, startEntries = entriesOf(startPlugin), placeholderPlugin = startPlugin, addPluginTab,
  performanceTrace = TRACE, settings = {}, log = {}, reads = [] } = {}) {
  requirePlugin(startPlugin, "the start state names no plugin for its start tab");
  const traceOffsets = currentEventOffsets(s.app.configDir);
  const declared = performanceTrace ? [...reads, "workbench.trace.surface.registration"] : reads;
  await prepareFixture(s, { settings, performanceTrace, log, reads: declared,
    catalog: declared.length ? recordCatalog(s.app.configDir) : undefined });
  // A record that remains belongs to an earlier run whose restore failed.
  await restoreRegistry(s);
  let tab;
  try {
    tab = await startLayout(s, { startPlugin, startEntries, placeholderPlugin });
    if (addPluginTab !== undefined) tab = { ...tab, pluginTab: await addTabOfPlugin(s, addPluginTab) };
  } catch (error) {
    if (!performanceTrace) throw error;
    throw new Error(`${error.message}; registration timeline: ${JSON.stringify(await registrationTimeline(s, traceOffsets))}`, { cause: error });
  }
  await s.presented();
  return tab;
}
