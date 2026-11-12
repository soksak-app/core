// Starting layout of the core window checks. The checks run on the core fixtures only (docs/spec/plugin-processes.md#verification-boundaries):
// each application has every plugin of the fixture registry pack `fixtures` installed, and no real plugin. The start state of
// @soksak/window-check/start.mjs opens the new-space layout that environment.json of the application declares (workspace.grid); its
// tabs name the plugins of the published starter, which a fixture configuration does not load, so they open as placeholders. The
// preparation replaces each such placeholder by a tab of the layout probe fixture `layoutprobe` in the same card and returns the tab
// of the focused card.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keepCommonSettings } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { joinedFailure } from "@soksak/window-check/failure.mjs";
import { recordCatalog as catalogOfConfiguration } from "@soksak/window-check/catalog.mjs";
import * as start from "@soksak/window-check/start.mjs";

/** The failure of several errors, which names the message of each (packages/window-check/failure.mjs). */
export { joinedFailure };

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
 * Waits until the settings dialog that core.settings.close closed is gone: a host with a main page removes its native modal web
 * view from host.window, and the mygo workbench, which draws it itself, empties core.modal (docs/spec/exposure.md).
 */
export async function settingsClosed(s, message) {
  if ((await s.get("host.window")).pageProcess !== null) {
    return s.until("host.window", (window) => window.modal === null, message);
  }
  return s.until("core.modal", (modal) => modal === null, message);
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
  await untilEventLine(s.app.configDir, offsets, (line) => line.includes("workbench.start"), { ...start.reading(s.app, ["workbench.start"]), ended: s.client.ended });
  await s.windows(1, `the page was not ready again after ${action}`);
}

/**
 * Runs `change`, a plugin change that starts the workbench of the window again, and returns `{workbench, result}`: core.window.workbench
 * of the new start and the result of `change`. The command answers before the new start (docs/spec/installation.md#applying-a-change),
 * and a page status refuses requests while the page starts again, so the wait reads the start from the event log
 * (pluginChangeApplied) and reads the workbench only after the host reports the page ready. A ready page answers requests
 * (`ready` of windows.list), which does not make its ready state complete: the mygo workbench reports its window ready before
 * the frame that draws its first screen, so the wait reads that start until it is complete, as the reload of a check does.
 */
export async function pluginChangeStarted(s, change, action) {
  const before = (await s.get("core.window.workbench")).start;
  const offsets = currentEventOffsets(s.app.configDir);
  const result = await change();
  await pluginChangeApplied(s, offsets, action);
  const started = await s.get("core.window.workbench");
  if (started.start === before) throw new Error(`${action} did not start the workbench again`);
  const workbench = await s.until("core.window.workbench",
    (value) => value.start === started.start && value.readyState === "complete",
    `${action}: the new workbench did not become complete`);
  return { workbench, result };
}


/**
 * Covers the window of `s` with `cover`, a ready window of the same application that the check opened, and returns the frame
 * of the covered window. host.windows lists a window ready before it is on the screen, because a host shows a new window after
 * its first screen (docs/spec/native-host.md#page-start), so the cover is judged by its presented layout and by a frame that
 * holds the whole covered window. A window that an inactive application shows goes directly above its frontmost window
 * (docs/spec/hosts.md#launch-activation), so the cover stands over the covered window. Every check starts behind the windows of a
 * person, so the occlusion of the cover itself is no criterion.
 */
export async function coverCheckWindow(s, cover) {
  const covered = (await s.get("host.window")).frame;
  await cover.run("host.window.resize", { width: covered.width + 200, height: covered.height + 100 });
  await cover.run("host.window.move", { x: covered.x - 100, y: covered.y - 50 });
  await cover.presented();
  const holds = ({ frame }) => frame.x <= covered.x && frame.y <= covered.y && frame.x + frame.width >= covered.x + covered.width
    && frame.y + frame.height >= covered.y + covered.height;
  await cover.until("host.window", holds,
    `the covering window does not hold the frame of the check window ${JSON.stringify(covered)}`);
  return covered;
}

/**
 * Holds the dialogs of the window of s for a check (docs/spec/exposure.md#dialogs): while the watch of host.dialog lasts, a dialog
 * of the window shows no panel and waits as a request that the check answers, so a check never shows a panel to the person. It
 * returns once the watch started. `asked(answer, what)` waits until the one request of host.dialog waits and returns it; the
 * pending answer of the command that asked fails the wait at once when it answers first. `end(last)` runs the last answer of the
 * check and waits until the watch ended with the change that it made.
 */
export async function holdDialogs(s) {
  let last = false;
  const watching = s.until("host.dialog", () => last, "the watch of host.dialog ended before the last answer");
  await s.until("host.dialog", (dialog) => dialog.pending.length === 0, "a dialog of the window waited before the check");
  return {
    async asked(answer, what) {
      const answeredFirst = answer.then((value) => {
        throw new Error(`${what} answered ${JSON.stringify(value)} before it asked for a dialog`);
      });
      const dialog = await Promise.race([answeredFirst,
        s.until("host.dialog", (value) => value.pending.length === 1, `${what} did not ask for a dialog`)]);
      return dialog.pending[0];
    },
    async end(lastAnswer) {
      last = true;
      await lastAnswer();
      await watching;
    },
  };
}
