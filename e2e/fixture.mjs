// Starting layout of the core window checks. The checks run on the core fixtures only (docs/spec/plugin-processes.md#verification-boundaries):
// each application has every plugin of the fixture registry pack `fixtures` installed, and no real plugin. The start state of
// @soksak/window-check/start.mjs opens the new-space layout that environment.json of the application declares (workspace.grid); its
// tabs name the plugins of the published starter, which a fixture configuration does not load, so they open as placeholders. The
// preparation replaces each such placeholder by a tab of the layout probe fixture `layoutprobe` in the same card and returns the tab
// of the focused card.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { recordCatalog as catalogOfConfiguration } from "@soksak/window-check/catalog.mjs";
import * as start from "@soksak/window-check/start.mjs";

export { placeholderTabs, reading, restoreRegistry, useRegistry } from "@soksak/window-check/start.mjs";

/**
 * The fixture plugin of the start tab: the layout probe (e2e/fixtures/layout-probe/layoutprobe). It reports its start values,
 * surface size and document region, and declares the sections and sets that a card sidebar of a check shows. The plain-view probe
 * reports none of these, so it is not the start tab.
 */
export const START_PLUGIN = "layoutprobe";

/** The entries that a start tab has registered when it is ready for a check. */
export const START_ENTRIES = Object.freeze(["status layoutprobe.view", "status layoutprobe.surface"]);

/** Replaces every placeholder tab of the start layout by a START_PLUGIN tab of its card; returns the new tabs as `{card, tab}`. */
export const replacePlaceholders = (s) => start.replacePlaceholders(s, START_PLUGIN);

/** Waits until the active tab of the focused card is a ready START_PLUGIN tab that registered START_ENTRIES and returns it. */
export const startTab = (s) => start.startTab(s, { startPlugin: START_PLUGIN, startEntries: START_ENTRIES });

/**
 * Paints the document region of the START_PLUGIN tab `surface` (inset 8pt in its view) in the CSS colour `colour` and returns once
 * the document reports it. The document applies a posted colour once its script listens, which its first report tells; a colour
 * posted before its load commits is refused, and one posted before its script listens is lost
 * (docs/spec/native-surfaces.md#document-regions).
 */
export async function paintProbeDocument(s, surface, colour) {
  await s.until("layoutprobe.document", (value) => value?.reported === true, `the document of ${surface} did not report`, { surface });
  await s.run("layoutprobe.document.color", { color: colour }, surface);
  await s.until("layoutprobe.document", (value) => value?.color === colour,
    `${surface} did not paint its document region ${colour}`, { surface });
}

/** The manifest of the layout probe (e2e/fixtures/layout-probe/layoutprobe/plugin.json). */
const LAYOUT_PROBE_MANIFEST = fileURLToPath(new URL("fixtures/layout-probe/layoutprobe/plugin.json", import.meta.url));

/**
 * The sections of the set `list` that the layout probe declares: the default sections of the card sidebar of a check. A check
 * configuration does not hold that set, because the sidebars of environment.json replace the default sets of the plugins
 * (docs/spec/plugins.md#default-sidebar-sets), so the check stores its own set of these sections.
 */
export function probeListSections(path = LAYOUT_PROBE_MANIFEST) {
  const sets = JSON.parse(readFileSync(path, "utf8")).sidebars?.sets ?? [];
  const list = sets.find((item) => item.id === "list");
  if (!Array.isArray(list?.sections) || list.sections.length === 0) throw new Error(`${path} declares no sections of its set list`);
  return list.sections;
}

/**
 * Gives each common sidebar set of the configuration the sections of the set that the layout probe declares with its layout, and
 * keeps its id, title and layout, so that every link of the configuration shows sections of a loaded plugin. The sets of
 * environment.json name sections of plugins that a fixture configuration does not load, which a sidebar keeps and does not show
 * (docs/spec/plugins.md#plugins-that-are-not-loaded), and they replace the default sets of the plugins
 * (docs/spec/plugins.md#default-sidebar-sets). keepCommonSettings restores the sets when the check ends. Returns the stored sets.
 */
export async function probeSidebarSets(s, path = LAYOUT_PROBE_MANIFEST) {
  const probe = JSON.parse(readFileSync(path, "utf8")).sidebars?.sets ?? [];
  await keepCommonSettings(s);
  const sets = (await s.get("core.settings")).values.sets.map((set) => {
    const like = probe.find((item) => item.layout === set.layout);
    if (!like) throw new Error(`the layout probe declares no set of the layout ${set.layout} of the set ${set.id}`);
    return { ...set, sections: like.sections };
  });
  if (sets.length === 0) throw new Error("the configuration holds no sidebar set");
  await s.run("core.settings.set", { patch: { sets }, scope: "common" });
  return sets;
}

/**
 * Waits until the settings dialog that core.settings.open opened is shown. A host with a main page shows it in a native modal web
 * view, which host.window reports shown; the mygo workbench draws it itself, and core.modal names it while it is open
 * (docs/spec/exposure.md, docs/spec/native-modals.md).
 */
export async function settingsShown(s, message) {
  if ((await s.get("host.window")).pageProcess !== null) {
    return s.until("host.window", (window) => window.modal?.id === "settings" && window.modal.shown, message);
  }
  return s.until("core.modal", (modal) => modal?.id === "settings", message);
}

/**
 * Puts a card-left sidebar on each card whose active tab is a tab of `plugin` (START_PLUGIN by default): it stores a common set
 * (start.mjs cardSidebar, the id `check-sections` by default) of `sections`, by default the sections of the list set of the layout
 * probe (probeListSections), and links it. Returns the ids of the card sidebars.
 */
export const cardSidebar = (s, { plugin = START_PLUGIN, set, sections = probeListSections(), layout } = {}) =>
  start.cardSidebar(s, { plugin, set, sections, layout });

/**
 * The declarations of the records that a check reads: the catalog of core joined with the catalogs of the plugins and sidecars
 * installed in the configuration folder of the application.
 */
export const recordCatalog = (app) => catalogOfConfiguration(app.configDir);

/** Puts the window in the start state of a check with a START_PLUGIN start tab (start.mjs fresh) and returns `{surface, plugin}`. */
export const fresh = (s, options = {}) => start.fresh(s, { ...options, startPlugin: START_PLUGIN, startEntries: START_ENTRIES });

/**
 * Waits until the page of the window has reloaded after a plugin operation that changed installed.json
 * (docs/spec/installation.md#applying-a-change). `offsets` are the positions of the event files before the operation: the new
 * document writes `workbench.start`, and `host.windows`, which the host answers while the page reloads, then reports the page ready.
 */
export async function pluginChangeApplied(s, offsets, action) {
  await untilEventLine(s.app.configDir, offsets, (line) => line.includes("workbench.start"), 30000, start.reading(s.app, ["workbench.start"]));
  await s.windows(1, `the page was not ready again after ${action}`);
}

/**
 * Runs `change`, a plugin change that starts the workbench of the window again, and returns `{workbench, result}`: core.window.workbench
 * of the new start and the result of `change`. The command answers before the new start (docs/spec/installation.md#applying-a-change),
 * and a page status refuses requests while the page starts again, so the wait reads the start from the event log
 * (pluginChangeApplied) and reads the workbench only after the host reports the page ready.
 */
export async function pluginChangeStarted(s, change, action) {
  const before = (await s.get("core.window.workbench")).start;
  const offsets = currentEventOffsets(s.app.configDir);
  const result = await change();
  await pluginChangeApplied(s, offsets, action);
  const workbench = await s.get("core.window.workbench");
  if (workbench.start === before) throw new Error(`${action} did not start the workbench again`);
  if (workbench.readyState !== "complete") throw new Error(`${action}: the new workbench is ${workbench.readyState}, not complete`);
  return { workbench, result };
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

/**
 * Uncovers the window of `s` from the windows of the other check applications: it opens each of `apps` but the application of `s`
 * inactive (an application outside the required set opens as null and owns no window), and parks their windows through
 * prepareOcclusionFixture, which restores every frame when the check ends. The check windows overlap, and the mygo window, centred
 * between the two others, is covered whole; a display measurement requires a window that reports `occluded` false, because WebKit
 * renders a covered window less often (`host.window`, docs/spec/exposure.md#host-entries), and a check orders no window in front of
 * the windows of other applications (docs/spec/hosts.md#launch-activation).
 */
export async function uncoverFromCheckWindows(t, s, { apps = APPS, openApp = open } = {}) {
  const otherWindows = [];
  for (const other of Object.values(apps)) {
    if (other.name === s.app.name) continue;
    const peer = await openApp(t, other, { inactive: true });
    if (peer === null) continue;
    for (const window of await peer.get("host.windows")) otherWindows.push(peer.on(window.window));
  }
  return prepareOcclusionFixture(s, otherWindows);
}
