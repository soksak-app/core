// Starting layout of the core window checks. The checks run on the core fixtures only (docs/spec/plugin-processes.md#verification-boundaries):
// each application has every plugin of the fixture registry pack `fixtures` installed, and no real plugin. diagnostics.fixture opens
// the new-space layout that environment.json of the application declares (workspace.grid); its tabs name the plugins of the
// published starter, which a fixture configuration does not load, so they open as placeholders. The preparation replaces each such
// placeholder by a tab of the layout probe fixture `layoutprobe` in the same card and returns the tab of the focused card.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keepCommonSettings, prepareFixture, TRACE } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { catalogOf } from "../scripts/check-events.mjs";

/**
 * The fixture plugin of the start tab: the layout probe (e2e/fixtures/layout-probe/layoutprobe). It reports its start values,
 * surface size and document region, and declares the sections and sets that a card sidebar of a check shows. The plain-view probe
 * reports none of these, so it is not the start tab.
 */
export const START_PLUGIN = "layoutprobe";

/** The entries that a start tab has registered when it is ready for a check. */
export const START_ENTRIES = Object.freeze(["status layoutprobe.view", "status layoutprobe.surface"]);

/**
 * The tabs of the layout `grid` (core.grid) that `surfaces` (core.surfaces) report as placeholders, the tabs of plugins that are not
 * loaded, as `{card, tab, plugin}` in the order of the cards and their tabs.
 */
export function placeholderTabs(grid, surfaces) {
  const placeholders = new Set(surfaces.filter((row) => row.kind === "tab" && row.placeholder != null).map((row) => row.surface));
  return (grid?.cards ?? []).flatMap((card) => (card.tabs ?? []).filter((tab) => placeholders.has(tab.id))
    .map((tab) => ({ card: card.id, tab: tab.id, plugin: tab.plugin })));
}

/**
 * Replaces every placeholder tab of the start layout by a tab of START_PLUGIN in its card: the new tab is added and activated first,
 * so the card never loses its last tab, and the placeholder tab is closed. Returns the new tabs as `{card, tab}`.
 */
export async function replacePlaceholders(s) {
  const added = [];
  for (const { card, tab } of placeholderTabs(await s.get("core.grid"), await s.get("core.surfaces"))) {
    const { tab: opened } = await s.run("core.card.add-tab", { card, plugin: START_PLUGIN });
    await s.run("core.tab.close", { tab });
    added.push({ card, tab: opened });
  }
  return added;
}

/**
 * Waits until the active tab of the focused card is a ready START_PLUGIN tab that registered START_ENTRIES, and returns it as
 * `{surface, plugin}`. A start layout whose focused card holds no START_PLUGIN tab fails with the grid.
 */
export async function startTab(s) {
  const grid = await s.get("core.grid");
  const focused = grid?.cards.find((card) => card.focused);
  const active = focused?.tabs?.find((tab) => tab.id === focused.active);
  if (active?.plugin !== START_PLUGIN) {
    throw new Error(`the focused card of the start layout holds no active ${START_PLUGIN} tab: ${JSON.stringify(grid?.cards ?? null)}`);
  }
  await s.until("core.surfaces", (surfaces) => surfaces.some((row) => row.surface === active.id && row.visible && row.status?.phase === "ready"),
    `the start tab ${active.id} did not become ready`);
  await s.registered(active.id, START_ENTRIES);
  return { surface: active.id, plugin: START_PLUGIN };
}

/**
 * Puts a card-left sidebar on each card whose active tab is a tab of `plugin` (START_PLUGIN by default). Without `sections` it links
 * the set `set` that the plugin declares (the layout probe declares `layoutprobe.list`, list layout, and `layoutprobe.tabs`, tabs
 * layout); with `sections` it first stores a common list set with the id `set` (by default `check-sections`) that holds those
 * sections. keepCommonSettings restores the sets and the links when the check ends. Returns the ids of the card sidebars.
 */
export async function cardSidebar(s, { plugin = START_PLUGIN, set, sections } = {}) {
  const id = set ?? (sections === undefined ? `${plugin}.list` : "check-sections");
  await keepCommonSettings(s);
  if (sections !== undefined) {
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: [...sets, { id, title: "검사", sections, layout: "list" }] }, scope: "common" });
  }
  await s.run("core.settings.link", { place: "card-left", plugin, set: id, scope: "common" });
  const cards = (await s.get("core.grid")).cards
    .filter((card) => card.tabs?.find((tab) => tab.id === card.active)?.plugin === plugin).map((card) => `${card.id}:left`);
  if (cards.length === 0) throw new Error(`no card shows an active ${plugin} tab for its card sidebar`);
  await s.until("core.sidebars", (value) => cards.every((sidebar) => value.some((item) => item.sidebar === sidebar && item.set === id)),
    `the card sidebars ${cards.join(", ")} did not show the set ${id}`);
  return cards;
}

/** The event catalog of this repository (docs/spec/logging.md#catalog). */
const CATALOG = fileURLToPath(new URL("../docs/spec/events.json", import.meta.url));

/**
 * The declarations of the records that a check reads: the catalog of this repository joined with the catalogs of the sidecars
 * installed in the configuration folder of the application.
 */
export const recordCatalog = (app) => catalogOf(JSON.parse(readFileSync(CATALOG, "utf8")), app.configDir);

/** The declaration `{ catalog, records }` of a wait of `untilEventLines` on the records that the predicate reads. */
export const reading = (app, records) => ({ catalog: recordCatalog(app), records });

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
 * Puts the window in the start state of a check and returns the start tab `{surface, plugin}`: diagnostics.fixture opens the
 * new-space layout, every placeholder tab of it is replaced by a START_PLUGIN tab (replacePlaceholders), and the active tab of the
 * focused card is ready (startTab). `log` is the log policy that the check declares and `reads` the records below `error` that it
 * reads (prepareFixture); with the performance trace the registration timeline of a failed start is read too.
 */
export async function fresh(s, { performanceTrace = TRACE, settings = {}, log = {}, reads = [] } = {}) {
  const traceOffsets = currentEventOffsets(s.app.configDir);
  const declared = performanceTrace ? [...reads, "workbench.trace.surface.registration"] : reads;
  await prepareFixture(s, { settings, performanceTrace, log, reads: declared, catalog: declared.length ? recordCatalog(s.app) : undefined });
  // A record that remains belongs to an earlier run whose restore failed.
  await restoreRegistry(s);
  let tab;
  try {
    await replacePlaceholders(s);
    tab = await startTab(s);
  } catch (error) {
    if (!performanceTrace) throw error;
    throw new Error(`${error.message}; registration timeline: ${JSON.stringify(await registrationTimeline(s, traceOffsets))}`, { cause: error });
  }
  await s.presented();
  return tab;
}

/**
 * Waits until the page of the window has reloaded after a plugin operation that changed installed.json
 * (docs/spec/installation.md#applying-a-change). `offsets` are the positions of the event files before the operation: the new
 * document writes `workbench.start`, and `host.windows`, which the host answers while the page reloads, then reports the page ready.
 */
export async function pluginChangeApplied(s, offsets, action) {
  await untilEventLine(s.app.configDir, offsets, (line) => line.includes("workbench.start"), 30000, reading(s.app, ["workbench.start"]));
  await s.windows(1, `the page was not ready again after ${action}`);
}


/** Prepares a real visible occlusion baseline without raising or activating a
 * window. The caller supplies only windows of its declared diagnostic cohort. */
export async function prepareOcclusionFixture(target, otherWindows) {
  const key = session => `${session.app.name}/${session.window}`;
  if (!target || !Array.isArray(otherWindows)) throw new TypeError("placement fixture requires an explicit owned cohort");
  const own = key(target), seen = new Set();
  for (const other of otherWindows) {
    const identity = key(other);
    if (identity === own) throw new Error("placement target cannot belong to the parked cohort");
    if (seen.has(identity)) throw new Error("placement fixture has duplicate parked window ownership");
    seen.add(identity);
  }
  const validFrame = frame => frame && ["x","y","width","height"].every(field=>Number.isFinite(frame[field]))
    && frame.width>0 && frame.height>0;
  const inactiveCount = state => {
    const observation = state?.activationObservation;
    if (state?.active !== false || observation?.registered !== true
      || typeof observation.count !== "string" || !/^(0|[1-9]\d*)$/.test(observation.count)) {
      throw new Error("placement fixture preparation requires actual inactive activation observation");
    }
    return observation.count;
  };
  const before = await target.get("host.window"), count = inactiveCount(before);
  const [screen] = await target.get("host.screens"), area = screen?.visible;
  if (!validFrame(before.frame) || !validFrame(area)) throw new Error("placement fixture preparation has invalid public screen/window geometry");
  const snapshots = [{ session: target, frame: { ...before.frame }, count }];
  for (const session of otherWindows) {
    const state = await session.get("host.window");
    if (!validFrame(state.frame)) throw new Error("placement fixture preparation has invalid owned cohort geometry");
    snapshots.push({ session, frame: { ...state.frame }, count: inactiveCount(state) });
  }
  for (const { frame } of snapshots) {
    if (frame.width>area.width || frame.y<area.y || frame.y+frame.height>area.y+area.height)
      throw new Error("placement fixture preparation cannot keep normal owned frames within the visible work area");
  }
  // Register the target and entire original cohort before any mutation, including a move
  // that fails after earlier windows have already moved.
  if (snapshots.length) target.cleanup(async () => {
    const failures = [];
    for (const { session, frame, count: originalCount } of snapshots) {
      try {
        const state = await session.get("host.window");
        if (state.frame.x !== frame.x || state.frame.y !== frame.y)
          await session.run("host.window.move", { x: frame.x, y: frame.y });
        const restored = await session.until("host.window", value =>
          ["x","y","width","height"].every(field=>value.frame[field]===frame[field]),
        "placement fixture did not restore the exact owned cohort frame");
        if (inactiveCount(restored) !== originalCount) throw new Error("placement cohort activation count changed during restoration");
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures,"placement owned cohort restoration failed");
  });
  const parked = [];
  for (const { session, frame, count: originalCount } of snapshots) {
    // A real inactive normal-frame observation established this exposed edge:
    // target left, other declared cohort windows right. Do not raise or resize.
    const x = session === target ? area.x : area.x + area.width - frame.width;
    if (frame.x !== x) await session.run("host.window.move", { x, y: frame.y });
    const actual = await session.until("host.window", value => value.frame.x===x && value.frame.y===frame.y
      && value.frame.width===frame.width && value.frame.height===frame.height,
    "placement fixture owned cohort move did not reach its exact frame");
    if (inactiveCount(actual) !== originalCount) throw new Error("placement cohort activation count changed during preparation");
    parked.push({ application:session.app.name, window:session.window, originalFrame:frame, parkedFrame:actual.frame });
  }
  // Other apps and user windows remain untouched. Their real occlusion is a
  // preparation failure, never a product failure or a reason to fake visibility.
  const baseline = await target.until("host.window", value => value.occluded === false,
    "placement fixture preparation remains occluded after owned cohort moves", { timeout: 2000 });
  if (inactiveCount(baseline) !== count) throw new Error("placement target activation count changed during preparation");
  return { before, baseline, parked };
}
