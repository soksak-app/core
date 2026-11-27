// Exposed entries of the core. Registers the status, command and element entries that exposure.json declares in the registry.
//
// Values are read from the state that modules hold and from the elements of the document. No entry runs arbitrary code.
//
// A change of a status is announced by calling coreChanged(). The document calls it after the render of the
// plane, after changes of projects and settings, and after the drawing of modals and the project home; the
// registry sends only the watched values that changed to the host.
import { createActivity } from "./activity.js";
import { contributionsState, onContributionsChange } from "./contributions.js";
import { checkOpenPath } from "./file-open.js";
import { registry, connectExposure, revisitRegistrations, whenRepliesSent } from "./exposure.js";
import { tabDescription } from "./card-data.js";
import { log, reloadView, report, requestPageReload } from "./host.js";
import { createPluginApply } from "./plugin-apply.js";
import { trace } from "./performance.js";
import { focusName, focusState } from "./focus-state.js";
import { onFocusSourceChange, setResponder } from "./view-focus.js";
import { trackPointer } from "./pointer-state.js";
import { losses, onPluginProcessChange, openCalls, views } from "./plugin-processes.js";
import { tabMenuItems } from "./tab-menu.js";
import { checkNotice, checkNoticeDone, checkNoticeProgress, EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";
import * as projects from "./projects.js";
import {
  activeTab, addTabTo, assignSidebar, openFile, capture, cardActs, cardTextSizes, changeTextSize, closeCard, closePicker, closeTabById,
  currentGrid, currentTextScope, dragState, focusCard, foldSidebar,
  drawnCardRects, focused, fresh, fullscreenCard, moveTab, presentedCardRect, toggleCardFullscreen, onPicker, onSurfaceState, openCardMenu, openCardTabs, openCardTools, openSpaceApps, openSurfaceMenu, openTabMenu, onSurfaceContextMenu, pickItem, pickerState, plane, railState, selectTab,
  cardSidebars, resizeSidebar, settle, settleModifiedTabs, settleModifiedTabsToClose, splitCard, surfaceState, tabsOf,
  openInLayout, selectInLayout, moveInLayout, closeInLayout, planInLayout, applyInLayout, layoutDescription, surfaceSpace, activityLayout,
  cardState, createGroup, currentTree, dissolveGroup, leadLevel, moveCard, openGroupMenu, renameGroup, storedLayoutText,
  cardSizeOf, onCardFrames,
} from "./plane.js";
import { emitEvent, eventAdmits } from "./page-log.js";
import { boundedJson, cutBytes } from "@soksak/plugin-api/bounded-json.js";
import {
  appliedPatch, applyTheme, controlValue, defaults, link, onSaved, overridden, reset, saving, scopedValue, set, setDebug, settingProject, THEMES, value,
} from "./settings.js";
import { changeRow, createSet, deleteSet, updateSet } from "./sidebar-sets.js";
import { pluginCategories, pluginUnits } from "./environment.js";
import { latest, seated } from "./compositor.js";
import {
  behindDialog, filePlace, modalState, onFilesDropped, onModalState, onWindowResponder, orderedCallsAnswered, overlayElementRect,
} from "./host.js";
import { keyboardResponder } from "./keyboard.js";
import { dialogSurfacePlugin } from "./dialogs.js";
import { hasPlugin, plugin, sectionSurfacePlugin } from "./registry.js";
import { compositionKindOf } from "./surface-composition-kind.js";
import { retainedSurfaceEntries, surfaceKindOf } from "./surface-listing.js";
import { liveMounts, onMountedChange, surfaceLeftOut } from "./surface-modules.js";
import { systemNotifications } from "./system-notifications.js";
import { windows } from "@soksak/runtime";
import { audit, onBinding } from "./commands.js";
import { onTextScope } from "./text-size.js";
import { foldSection, onSectionsChange, sectionDrawn, selectSection, sidebarsState, sizeSections } from "./sidebar-sections.js";
import { noticeTargetOfTab, notificationStore, onTabReports, reportPageNotice, tabError, tabFooter, tabLabel, tabModified } from "./tab-reports.js";
import { appUpdate, followActivation, followPluginChanges, followSidecarChanges, onPluginOperations, pluginOperations } from "./installed-plugins.js";
import { followOutdatedSidecars } from "./sidecar-outdated.js";
import { pageIdentity } from "./page-identity.js";
import { PLACEMENT_LAST, placementLast } from "./page-layout.js";
import { errorToasts } from "./shown-errors.js";
import { stateCards } from "./layout-tree.js";
import { bindShown, cardFramesRedrawn, checkShowOwnedSession, endOwnedSession, inputOwnedSession, openOwnedSession, ownedSessionsState, readOwnedSession, resizeOwnedSession, startOwnedSessions, submitOwnedSession } from "./owned-sessions.js";

/* Receivers of the watched core statuses. */
const watchers = new Set();
let scheduled = false;

/**
 * Announces that the core state may have changed. Several calls within the same task are merged into one.
 */
export function coreChanged() {
  revisitRegistrations(report);
  if (scheduled || watchers.size === 0) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    // A watcher whose read fails reports its error and the other watchers still receive their values.
    for (const run of watchers) {
      try {
        run();
      } catch (error) {
        report(`core status: ${error.message}`);
      }
    }
  });
}

/**
 * The projects of this window for its activities (docs/spec/activity.md): the projects that the window opened, the shown space with
 * its drawn layout.
 */
function activityProjects() {
  const shown = projects.inHome() ? null : projects.active();
  const drawn = activityLayout();
  return projects.local().map((project) => (project.id !== shown?.id || drawn === null ? project : {
    ...project, spaces: project.spaces.map((space) => (space.id === project.activeSpaceId ? { ...space, layout: drawn } : space)),
  }));
}

/* The receivers of a change of the activities: the drawings of the icons. */
const activityListeners = new Set();
/* The receiver of the error of the activity values of a tab, which the error display of the page shows (docs/spec/activity.md). */
let activityFailed = null;
/* The receiver of the error of the program values of a tab, which the error display of the page shows (docs/spec/program-state.md). */
let programFailed = null;

const activityChanged = () => {
  for (const listener of activityListeners) listener();
  coreChanged();
};

/* The record of the activities of the projects of the application that the host sent last, by its revision
   (docs/spec/activity.md#activity-of-a-project); -1 until the first record arrives. */
let projectRecord = { revision: -1, projects: {} };
/* The publications of this window, one after the other, so that the host receives the activities of a project in the order of their
   changes. */
let publishing = Promise.resolve();

/* The activities of this window, which follow the statuses of the plugins that declare activity on each surface and publish the
   activities of the spaces of each project of the window to the host. */
const activity = createActivity({
  observe: (name, surface, fn) => registry.observe(name, surface, fn, { exact: true }),
  // default: a tab of a plugin that is not loaded, and a plugin record without activity, follow no status.
  statuses: (id) => (hasPlugin(id) ? plugin(id).activity ?? [] : []),
  // default: a tab of a plugin that is not loaded, and a plugin without surface.program, has no program status.
  programStatus: (id) => (hasPlugin(id) ? plugin(id).program ?? null : null),
  projects: activityProjects,
  failed: (tab, text) => activityFailed(tab, text),
  programFailed: (tab, text) => programFailed(tab, text),
  changed: activityChanged,
  publish: (id, spaces) => {
    publishing = publishing.then(() => windows.projectActivity({ id, spaces })).catch((error) => {
      dispatchEvent(new ErrorEvent("error", { message: `projectActivity ${id}: ${error.message}` }));
    });
  },
});

/** Starts and ends the watches of the activities after the layout, the projects or the plugins of the window changed. */
export const syncActivity = () => activity.sync();

/**
 * The value of core.activity: the record of the projects of the application and the activities of the tabs of this window
 * (docs/spec/activity.md#status).
 */
export const activityState = () => ({ projects: projectRecord.projects, tabs: activity.state().tabs });

/** Keeps the record of the project activities of the highest revision that the host sent. */
function receivedProjectRecord(record) {
  if (record.revision <= projectRecord.revision) return;
  projectRecord = record;
  activityChanged();
}
projects.onProjectActivity(receivedProjectRecord);

/** Sets the receiver of the error text of the activity values of a tab, null when it is withdrawn. */
export function onActivityError(receiver) {
  activityFailed = receiver;
}

/** Sets the receiver of the error text of the program values of a tab, null when it is withdrawn (docs/spec/program-state.md#value). */
export function onProgramError(receiver) {
  programFailed = receiver;
}

/** The program state of a tab for core.grid, or null when the tab has none (docs/spec/program-state.md#status). */
// default: a tab without a reported program state has program null in core.grid (docs/spec/program-state.md#status).
const programOf = (tab) => activity.programs()[tab] ?? null;

/** Calls listener after the activities of this window changed. */
export function onActivity(listener) {
  activityListeners.add(listener);
}

/* The file last dropped on the window and the result of its handling: core.drop of docs/spec/native-surfaces.md. */
let lastDrop = null;

/**
 * Passes a file dropped on the window to the surface that owns the DOM element at that point. A native view is placed over the DOM, so the surface is found through the DOM, and the drop command that the plugin of that surface declared runs on that surface.
 */
async function dropFiles(payload) {
  const record = { urls: null, x: null, y: null, surface: null, command: null, error: null };
  log(`drop: received ${payload}`);
  try {
    // The host sends the JSON string that the native drop view made as it is.
    const { urls, x, y } = JSON.parse(payload);
    Object.assign(record, { urls, x, y });
    if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string") ||
      !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("the application sent an invalid file drop");
    }
    const slot = document.elementFromPoint(x, y)?.closest("[data-native-surface-id][data-native-surface]");
    if (!slot) throw new Error("no surface is under the drop point");
    record.surface = slot.dataset.nativeSurfaceId;
    const command = plugin(slot.dataset.nativePlugin).drop;
    if (!command) throw new Error(`plugin ${slot.dataset.nativePlugin} declares no drop command`);
    record.command = command;
    const reply = await registry.handle({ method: "command.run", params: { name: command, params: { urls }, surface: record.surface } });
    if (reply.error) throw new Error(reply.error.message);
    log(`drop: command ${command} accepted ${urls.length} file(s) on surface ${record.surface}`);
  } catch (error) {
    record.error = error.message;
    report(`drop: ${error.message}`);
  }
  lastDrop = record;
}

/** Applies a plugin change to this window: the questions of modified tabs, then a page reload (core.plugins.apply). */
const applyPluginChange = createPluginApply({
  settle: settleModifiedTabs, flush: projects.flush, reload: (cause) => whenRepliesSent().then(() => requestPageReload(cause)),
});

/**
 * Subscribes to plugin changes and applies a change made before the subscription (installed-plugins.js). The page
 * calls it after the projects are initialised, because the apply saves them (F199.4).
 */
export function followPlugins() {
  return followPluginChanges(applyPluginChange);
}

/** Handler of the core.plugins.<action> commands. plugin is a non-empty string (Plugin screen of docs/spec/installation.md). */
function pluginCommand(action) {
  // An install, update or enable that a running service holds runs with end, which ends that service
  // (docs/spec/persistent-services.md#updates).
  const ends = ["install", "update", "enable"].includes(action);
  return async ({ plugin, ...rest }) => {
    if (typeof plugin !== "string" || plugin === "") {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "plugin must be a non-empty string");
    }
    if (ends && "end" in rest && rest.end !== true) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "end must be true");
    await pluginOperations.run(action, plugin, ends && rest.end === true);
  };
}

/**
 * Delivers to fn the value of one read of a status. A read that answers later, as core.tab.role reads the workspace store of the host,
 * delivers the value that it resolves, and only the latest read of turn delivers, so an earlier answer that arrives late is not sent
 * after a newer one; its failure is reported as the failure of a core watcher.
 */
function deliverRead(value, fn, turn, latest) {
  if (typeof value?.then !== "function") return fn(value);
  value.then((resolved) => { if (turn === latest()) fn(resolved); },
    // default: a rejection value that is not an Error has no message, so the report names the value itself.
    (error) => { if (turn === latest()) report(`core status: ${error?.message ?? error}`); });
}

/** Registers one core status. The value is read again when coreChanged is called. */
function status(name, read, options) {
  registry.status(name, read, (fn, surface) => {
    let reads = 0;
    const run = () => deliverRead(read(surface), fn, ++reads, () => reads);
    watchers.add(run);
    return () => watchers.delete(run);
  }, options);
}

let verified = null;

/** Records the last verification result. */
export function setVerify(results) {
  const rows = results.filter((row) => !row.skipped);
  verified = {
    failed: rows.filter((row) => !row.ok).length,
    rows,
    skipped: results.filter((row) => row.skipped).map(({ name, note }) => ({ name, note })),
  };
  coreChanged();
}

const planeOrigin = () => {
  const r = plane.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

const shift = (rect, origin) => ({ x: rect.x + origin.x, y: rect.y + origin.y, w: rect.w, h: rect.h });

/**
 * Finds the plugin of a surface: the plugin of its section, the plugin of the open dialog, or the
 * plugin of a tab of the active space or of a stored space.
 */
function surfacePlugin(surface) {
  // default: a surface that is no section is looked up as the page of the open dialog.
  const owner = sectionSurfacePlugin(surface) ?? dialogSurfacePlugin(surface);
  if (owner !== null) return owner;
  // default: there is no card before the plane is created.
  for (const card of currentGrid()?.cards ?? []) {
    const tab = tabsOf(card).find((t) => t.id === surface);
    if (tab) return tab.plugin;
  }
  for (const project of projects.local()) {
    for (const space of project.spaces) {
      for (const card of stateCards(space.layout.state)) {
        // default: a seat card has null data, so it has no tabs.
        const tab = (card.data?.tabs ?? []).find((t) => t.id === surface);
        if (tab) return tab.plugin;
      }
    }
  }
  return null;
}

/** Order of the surfaces that receive a request: the tab of the focused card, then the visible surfaces. */
function preferred() {
  const grid = currentGrid();
  const card = grid && focused() ? grid.card(focused()) : null;
  const first = card ? activeTab(card)?.id : null;
  // default: a window that has not reported a composition yet has no visible surfaces.
  const visible = (latest()?.surfaces ?? []).filter((s) => s.visible).map((s) => s.id);
  return [first, ...visible].filter(Boolean);
}

function gridState() {
  const grid = currentGrid();
  if (!grid) return null;
  const tree = currentTree();
  // The rectangles that the plane draws: below the headers of the group cards, and the fullscreen layout of a fullscreen group card.
  const rects = drawnCardRects();
  const fullscreen = fullscreenCard();
  let pane = 0;
  // The cards of the grid in workbench order (docs/spec/groups.md#status-and-queries); a card that has no element yet is not reported.
  const cards = tree.order().filter(({ node }) => !node).map(({ id }) => {
    const card = grid.card(id);
    const el = plane.querySelector(`.card[data-card-id="${CSS.escape(id)}"]`);
    if (!card || !el) return null;
    const rect = rects.get(card.id);
    const tabs = tabsOf(card);
    // A card that a fullscreen card hides shows no head and no pane (docs/spec/example-model.md#card-fullscreen).
    const drawn = !el.hidden && el.querySelector(".chrome__acts") !== null;
    return {
      fullscreen: card.id === fullscreen,
      id: card.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      c0: card.c0, c1: card.c1, r0: card.r0, r1: card.r1,
      // default: a card without a fixed px width has null width.
      fixed: Boolean(card.fixed), width: card.width ?? null, focused: card.id === focused(),
      pane: drawn ? pane++ : null,
      // The members of a tab are those of the layout tabs (docs/spec/groups.md#status-and-queries), beside its presentation members.
      tabs: tabs.map(({ id }) => ({ ...tabDescription(card, id, tabLabel(id)), label: tabLabel(id),
        footer: tabFooter(id), modified: tabModified(id), error: tabError(id), program: programOf(id) })),
      // The newest shown notice of the card, and the text of its content footer, which is null while a notice shows (docs/spec/notifications.md#card-status-line).
      notice: cardNotice(card.id),
      // default: a card that is not drawn yet has no footer text element, so the text is empty.
      status: cardNotice(card.id) === null ? el.querySelector(":scope > .status .status__text")?.textContent ?? "" : null,
      active: tabs.length ? activeTab(card).id : null,
      acts: drawn ? cardActs(card.id) : null,
      sidebars: cardSidebars(card, presentedCardRect(card.id)),
      ...levelMembers(tree, card.id),
    };
  }).filter(Boolean);
  // The group cards stand in groups in workbench order, each with its drawn rectangle, so cards holds one shape (docs/spec/groups.md#status-and-queries).
  const groups = tree.nodes().map((node) => {
    const { x, y, w, h } = rects.get(node.card);
    return { id: node.card, x, y, w, h, ...levelMembers(tree, node.card),
      group: { name: node.name, level: tree.level(node.card) + 1, leader: node.leader } };
  });
  const lines = (axis) => grid.lines(axis).map((_, k) => grid.boundaryPos(axis, k));
  return {
    fullscreen,
    width: grid.width, height: grid.height, gap: grid.gap, plane: planeOrigin(),
    lines: { x: lines("x"), y: lines("y") }, cards, groups,
  };
}

/** The members of a card of core.grid for its level: parent, the group card that holds it or null in the root level, and leader, whether it leads its level. */
function levelMembers(tree, id) {
  const parent = tree.parentOf(id);
  return { parent: parent ? parent.card : null, leader: tree.leaderOf(parent) === id };
}

/* The memory saver of the page (memory-saver.js), given at installCoreExposure. */
let memory = null;

/** The tab of a core.tab command: a string that the memory saver knows, otherwise invalid params. */
function memoryTab(tab) {
  if (typeof tab !== "string") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `unknown tab ${JSON.stringify(tab)}`);
  try {
    return memory.tab(tab);
  } catch (error) {
    throw new ExposureError(EXPOSURE_ERRORS.invalidParams, error.message);
  }
}

function surfacesState() {
  // The tab of a plugin that is not loaded shows a placeholder instead of a surface, and the placeholder reports the reason (docs/spec/plugins.md).
  const placeholders = [...document.querySelectorAll("[data-plugin-placeholder]")].map((el) => ({
    surface: el.dataset.surfaceId, plugin: el.dataset.plugin, visible: true, placeholder: el.dataset.pluginPlaceholder,
    composition: null, kind: "tab", sidebar: null,
  }));
  const record = seated();
  // A mounted view that the record does not hold is a retained view; it is listed without a placement (docs/spec/exposure.md).
  const retained = (seatedIds) => retainedSurfaceEntries(liveMounts().map(({ descriptor, ...mount }) => ({
    ...mount, ...surfaceKindOf(descriptor), exposes: registry.namesOf(mount.surface),
    composition: compositionKindOf(descriptor),
    state: memory.unloaded(mount.surface) ? "unloaded" : "loaded",
  })), seatedIds);
  if (!record) return [...placeholders, ...retained(new Set())];
  const at = planeOrigin();
  return [...record.surfaces.map((s) => ({
    surface: s.id, plugin: s.plugin, visible: s.visible, dim: s.dim,
    declared: shift(s.declared, at), applied: shift(s.applied, at),
    exposes: registry.namesOf(s.id), status: surfaceState(s.id), placeholder: null,
    composition: compositionKindOf(s.surface), ...surfaceKindOf(s.surface),
    state: memory.unloaded(s.id) ? "unloaded" : "loaded",
  })), ...placeholders, ...retained(new Set(record.surfaces.map((s) => s.id)))];
}

// The settings tab and the debug view load at their first use, so the first window reads no code of them
// (docs/spec/native-host.md#page-start). A screen that never loaded is closed.
let settingsScreen = null;
let debugScreen = null;

/** The listeners of the front of the settings tab, and of its status. */
const tabFrontListeners = new Set();
const tabStatusListeners = new Set();

/** Loads the settings tab at its first use and registers its commands once. */
const settingsUi = async () => {
  if (settingsScreen === null) {
    const screen = await import("./settings-ui.js");
    screen.installSettingsTab((value) => { for (const fn of tabStatusListeners) fn(value); });
    screen.onSettingsTabFront((front) => {
      if (front) closeDebug();
      for (const fn of tabFrontListeners) fn(front);
      coreChanged();
    });
    settingsScreen = screen;
  }
  return settingsScreen;
};

/** Whether the settings tab is in front; false while the tab has not loaded. */
// default: the settings tab is not in front while its screen has not loaded.
export const settingsTabFront = () => settingsScreen?.settingsTabFront() ?? false;
/** Subscribes to the front of the settings tab, which the window uses for its surfaces. */
export const onSettingsTabFront = (fn) => { tabFrontListeners.add(fn); return () => tabFrontListeners.delete(fn); };
/** Mounts the content of the settings tab into container; the tab is in front only after it has loaded. */
export const mountSettingsTab = (container) => { settingsScreen.mountSettingsTab(container); };

const debugUi = async () => {
  debugScreen ??= await import("./debug-ui.js"); // default: a loaded screen is kept.
  debugScreen.onDebugDrawn(coreChanged);
  return debugScreen;
};

/** A command of the debug view. */
const onDebug = (run) => async (params) => run(debugScreen ?? await debugUi(), params); // default: a loaded screen is kept.

// default: a screen that is not loaded is closed.
const debugState = () => debugScreen?.debugState() ?? {
  open: false, recorded: null, captures: [], entries: [], viewing: null, timeline: null, state: null, scroll: 0, operation: null, error: null,
};
const closeDebug = () => { debugScreen?.closeDebug(); };

/** Draws the settings tab again when it is mounted; the rows and pages of the tab read the current settings. */
export const redrawSettings = () => { settingsScreen?.redrawSettingsTab(); };

const withOpen = (project) => ({ ...project, open: projects.isOpen(project.id) });

/** Gives keyboard focus to the element of an element name. */
function focusElement(name, index = 0) {
  if (!registry.list().element.some((entry) => entry.name === name)) throw new Error(`unknown element ${name}`);
  const el = document.querySelectorAll(`[data-expose="${name}"]`)[index];
  if (!el) throw new Error(`element ${name} has no element at index ${index}`);
  el.focus();
}

/** Changes one setting to the input value. A control gives a string, which becomes the type that the setting declares. */
function changeSetting(key, input, scope, actor) {
  if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting: ${key}`);
  // default: scope is an optional parameter, and when it is omitted the global scope is used (core.settings.change in exposure.json).
  return set({ [key]: controlValue(key, input) }, scope ?? "common", actor);
}

function need(project, id) {
  if (!project) throw new Error(`Unknown project: ${id}`);
  return project;
}

/**
 * Registers the core entries and connects the registry to the host.
 *
 *   home     return value of createHome
 */
/**
 * drawn returns a promise that is fulfilled when the plane has finished all scheduled drawing. A core command waits for that drawing after it ran and then replies. When a command changes the layout, the receiver of the reply reads the layout that is already drawn.
 */
// The bounds of the texts of workbench.layout.change in UTF-8 bytes: the parameters and the answer, and the layout, which keeps the
// fields within the bound of an event (docs/spec/events.json).
const LAYOUT_CALL_BYTES = 1024;
const LAYOUT_BYTES = 61440;

/**
 * Observes the command name with params: when it succeeded and the stored layout of the active space differs from the one before it,
 * the command is the event workbench.layout.change with its parameters, its answer and the layout that it left (docs/spec/events.json).
 * The layout is read only while the gate stores the event.
 */
function watchLayout(name, params) {
  if (!eventAdmits("debug", "workbench.layout.change")) return null;
  const before = storedLayoutText();
  return (result) => {
    const after = storedLayoutText();
    if (after === before) return;
    emitEvent("debug", "workbench.layout.change", () => {
      const given = boundedJson(params, LAYOUT_CALL_BYTES);
      // default: a command that answers nothing replies null, as the endpoint answers it.
      const answered = boundedJson(result ?? null, LAYOUT_CALL_BYTES);
      // default: the window shows no layout after the command, and its layout is the JSON text null.
      const layout = cutBytes(after ?? "null", LAYOUT_BYTES);
      return { command: name, params: given.text, paramsTruncated: given.truncated, result: answered.text,
        layout: layout.text, layoutTruncated: layout.truncated };
    });
  };
}

// The newest shown notice of a card for core.grid: its id, kind and title, or null (docs/spec/notifications.md#card-status-line).
const cardNotice = (card) => {
  const notice = notificationStore().lineOf(card);
  return notice === null ? null : { id: notice.id, kind: notice.kind, title: notice.base };
};

/**
 * Registers the notices: the statuses core.notices and core.toasts and the commands of the notice center and the toasts (docs/spec/notifications.md#commands-and-statuses).
 * It runs before the first screen or a failure that stops the start, so the error display is registered before either.
 */
export function installErrorExposure() {
  const errors = errorToasts(document);
  const store = notificationStore();
  if (registry.list().status.some(({ name, registered }) => name === "core.notices" && registered)) return errors;
  // A notice command with an invalid value or an unknown id fails with -32602 (docs/spec/exposure.md#errors).
  const invalid = (action) => {
    try {
      return action();
    } catch (error) {
      if (error instanceof RangeError) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `${error.message}`);
      throw error;
    }
  };
  status("core.notices", () => store.status());
  status("core.toasts", () => store.toastStatus());
  registry.command("core.notices.toggle", () => store.toggle());
  registry.command("core.notices.filter", ({ filter }) => invalid(() => store.setFilter(filter)));
  registry.command("core.notices.read-all", () => store.readAll());
  registry.command("core.notices.clear", ({ group }) => invalid(() => store.clear(group)));
  registry.command("core.notices.clear-all", () => store.clearAll());
  registry.command("core.notices.close", ({ id }) => invalid(() => store.close(id)));
  registry.command("core.notices.read", ({ id }) => invalid(() => store.read(id)));
  registry.command("core.notices.show", ({ id }) => invalid(() => store.showEntry(id)));
  registry.command("core.toasts.list", ({ open }) => invalid(() => store.setList(open)));
  // The notice commands run the one path of tab.notify, tab.progress and tab.done: a refused field is -32602 with the text of the check.
  const refusedNotice = (action) => {
    try {
      return action();
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, error.message);
      throw error;
    }
  };
  // Gives a card or a plugin a notice; exactly one of card and plugin is given (docs/spec/notifications.md#commands-and-statuses).
  registry.command("core.notices.add", ({ card, plugin: pluginId, ...fields }) => refusedNotice(() => {
    if ((card === undefined) === (pluginId === undefined)) throw new RangeError("core.notices.add takes exactly one of card and plugin");
    if (pluginId !== undefined) {
      if (!hasPlugin(pluginId)) throw new RangeError(`plugin ${pluginId} does not exist`);
      return reportPageNotice(fields, pluginId);
    }
    const target = currentGrid()?.card(card);
    if (!target) throw new RangeError(`card ${card} does not exist`);
    const tab = activeTab(target);
    if (!tab) throw new RangeError(`card ${card} has no tab`);
    return notificationStore().showTab(checkNotice(fields), { card, tab: tab.id, plugin: tab.plugin, label: tab.title });
  }));
  // The store refuses an id that is not a progress notice with a plain Error, so the command checks it first and refuses it as -32602.
  const progressNotice = (id) => {
    const notice = notificationStore().notice(id);
    if (notice === null) throw new RangeError(`notice ${id} is not an entry`);
    if (notice.kind !== "progress") throw new RangeError(`notice ${id} is not a progress notice`);
  };
  registry.command("core.notices.progress", ({ id, progress }) => refusedNotice(() => {
    const checked = checkNoticeProgress({ id, progress });
    progressNotice(checked.id);
    notificationStore().progress(checked.id, checked.progress);
  }));
  registry.command("core.notices.done", ({ id, kind, title }) => refusedNotice(() => {
    const checked = checkNoticeDone({ id, kind, title });
    progressNotice(checked.id);
    notificationStore().done(checked.id, checked.kind, checked.title);
  }));
  errors.watch(coreChanged);
  return errors;
}

/**
 * Checks a new tab entry of core.layout.apply: a tab whose params name a session shows it, as a tab of core.layout.open does, so the
 * session must be open and belong to the plugin of the tab (docs/spec/plugins.md#owned-sessions).
 */
export function applySessionCheck(entry) {
  const session = entry.params?.session;
  if (session === undefined) return;
  if (typeof session !== "string" || session === "") throw new Error("core.layout.apply: session must be a session identifier");
  checkShowOwnedSession(session, entry.plugin);
}

/** Records that the new tab of core.layout.apply shows the session that its params name, and sizes the session to its card. */
export function applySessionShow(tab, entry) {
  const session = entry.params?.session;
  if (session !== undefined) bindShown(session, tab, cardSizeOf(tab));
}

export async function installCoreExposure({ home, renames, chrome, drawn, memorySaver }) {
  // The core entries read the memory saver (core.tab.memory, core.surfaces, the tab commands), so a page without it is refused
  // before any entry is registered.
  if (typeof memorySaver !== "object" || memorySaver === null) {
    throw new TypeError("installCoreExposure requires memorySaver, the memory saver of the page (memory-saver.js)");
  }
  memory = memorySaver;
  installErrorExposure();
  registry.watch(watchLayout);
  // On this host the workbench is the main page: a start is its page identity, and it started at its time origin.
  // The role handshake of a tab (docs/spec/agent-roles.md#tab-role-state): the status is read from the host store with the
  // surface of its request, and a change of the stored workspace refreshes every open watch (exposure.js).
  status("core.tab.role", (surface) => projects.roleOf(surface), { surface: true });
  status("core.window.close", () => projects.closeStatus());
  status("core.window.workbench", () => ({
    start: pageIdentity,
    startedAt: performance.timeOrigin,
    readyState: document.readyState,
    visibility: document.visibilityState,
    scheme: document.documentElement.style.colorScheme,
    background: window.__soksakBackground === true,
    scale: devicePixelRatio,
    width: innerWidth,
    height: innerHeight,
  }));
  status("core.screen", () => ({
    screen: document.body.dataset.screen,
    modal: debugState().open ? "debug" : pickerState().open ? "picker" : null,
  }));
  status("core.workbench.audit", () => ({ unbound: audit(document.body) }));
  // WebKit stops animation frames when it hides the document, so a change of the visibility state is announced.
  document.addEventListener("visibilitychange", coreChanged);
  onBinding(coreChanged);
  status("core.activity", activityState);
  // The role definitions (docs/spec/agent-roles.md#role-status): the status is read from the host store, and a change of roles.json
  // re-reads it while a watch of it is open (projects.onRolesChange).
  const readRoles = () => projects.rolesStatus();
  let roleReads = 0;
  registry.status("core.roles", readRoles, (changed) => projects.onRolesChange(() => deliverRead(readRoles(), changed, ++roleReads, () => roleReads)));
  status("core.projects", () => projects.all().map(withOpen));
  status("core.project", () => {
    const project = projects.active();
    return project && !projects.inHome() ? withOpen(project) : null;
  });
  // The stored form of the layout with the level of each group node (docs/spec/groups.md#status-and-queries).
  status("core.layout", () => (currentGrid() ? capture() : null));
  status("core.grid", gridState);
  status("core.sidebars", sidebarsState);
  onSectionsChange(coreChanged);
  onPluginOperations(coreChanged);
  followSidecarChanges();
  followOutdatedSidecars({ store: notificationStore(), targetOf: noticeTargetOfTab });
  followActivation();
  onTabReports(coreChanged);
  status("core.surfaces", surfacesState);
  // The owned sessions of this page (docs/spec/plugins.md#owned-sessions). The restart reconciliation waits for the initial project context.
  status("core.sessions", ownedSessionsState);
  startOwnedSessions();
  // The frames of the cards change with each redraw of the plane; a shown session takes the frame of its card (docs/spec/plugins.md#owned-sessions).
  onCardFrames(() => cardFramesRedrawn(cardSizeOf));
  status("core.tab.memory", () => ({ enabled: value("memorySaver"), delay: value("memorySaverDelay"), ...memory.status() }));
  status("core.drop", () => lastDrop);
  status("core.notifications", () => systemNotifications.state());
  systemNotifications.onChange(coreChanged);
  onFilesDropped((drop) => { dropFiles(drop).then(coreChanged); });
  status("core.settings", () => ({
    values: Object.fromEntries(Object.keys(defaults).map((key) => [key, value(key)])),
    common: Object.fromEntries(Object.keys(defaults).map((key) => [key, scopedValue(key, "common")])),
    project: settingProject(),
    overridden: Object.keys(defaults).filter(overridden),
    saving: saving(),
  }));
  status("core.themes", () => THEMES);
  status("core.debug", debugState);
  status("core.contributions", contributionsState);
  onContributionsChange(coreChanged);
  status("core.plugins", () => pluginOperations.status());
  // The categories are fixed when the environment is installed, so the status is read once and never changes while the window runs.
  status("core.plugin-categories", () => pluginCategories());
  status("core.app", () => appUpdate.status());
  status("core.picker", pickerState);
  status("core.home", () => home.state());
  status("core.verify", () => verified);
  status("core.modal", modalState);
  status("core.drag", dragState);
  status("core.rename", renames.state);
  status("core.plugin.open-calls", openCalls);
  status("core.plugin.losses", losses);
  status("core.plugin.views", views);
  onPluginProcessChange(coreChanged);
  status("core.focus", () => focusState(document));
  onFocusSourceChange(coreChanged);
  onWindowResponder((event) => {
    try {
      setResponder(event);
      keyboardResponder(event);
    } catch (error) {
      report(`window responder: ${error.message}`);
    }
  });
  status("core.pointer", trackPointer(document, coreChanged));
  // Observation of document focus transitions (V5-114). The image region is click-transparent, so a press makes the document take focus back, and the address bar that remained as activeElement can receive focus and become visible at that moment. Every transition leaves one line in the performance trace and the diagnostic log and announces core.focus. The elements of a surface are inside a shadow root, so the name is read from the actual target of the event.
  document.addEventListener("focusin", (event) => {
    trace("focus", { phase: "in", element: focusName(event) });
    log(`focus in ${focusName(event)}`);
    coreChanged();
  }, true);
  document.addEventListener("focusout", (event) => {
    trace("focus", { phase: "out", element: focusName(event) });
    log(`focus out ${focusName(event)}`);
    coreChanged();
  }, true);
  status("core.text", () => ({ scope: currentTextScope(), frame: value("textSize"), cards: cardTextSizes() }));
  onTextScope(() => coreChanged());
  status("core.chrome", chrome);
  status("core.rail", () => (currentGrid() ? railState() : null));

  // A refusal of a settings command is an invalid request argument (docs/spec/settings.md).
  const invalid = (run) => async (params) => {
    try {
      return await run(params);
    } catch (error) {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, error.message);
    }
  };
  // The host asks it before it waits for the presentation of the window (docs/spec/host-contract.md).
  registry.method(PLACEMENT_LAST, placementLast);
  // The host asks each ready window for the space that holds a surface and answers surface.window with the window and the space
  // (docs/spec/exposure.md#methods). A section surface belongs to a sidebar of this window and to no layout of a space, so a drawn
  // section answers the space null.
  registry.method("surface.window", ({ surface }) => {
    if (typeof surface !== "string" || surface === "") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "surface must be a non-empty string");
    const space = surfaceSpace(surface);
    if (space !== null) return { space };
    return sectionDrawn(surface) ? { space: null } : null;
  });
  registry.command("core.settings.set", invalid(async ({ patch, scope }) => {
    await set(patch, scope, "core.settings.set");
  }));
  registry.command("core.settings.reset", async ({ key }) => { await reset(key, "core.settings.reset"); });
  registry.command("core.settings.debug", async ({ on }) => {
    if (typeof on !== "boolean") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "on must be a boolean");
    await setDebug(on, "core.settings.debug");
  });
  registry.command("core.settings.change", invalid(async ({ key, value: input, scope }) => {
    await changeSetting(key, input, scope, "core.settings.change");
  }));
  // The folder control of a setting: the system folder dialog gives the folder, and a cancelled dialog changes nothing.
  registry.command("core.settings.choose-folder", invalid(async ({ key, scope = "common" }) => {
    const path = await windows.chooseFolder();
    if (!path) return;
    await changeSetting(key, path, scope, "core.settings.choose-folder");
  }));
  // The side key of a window side negates its applied value, written to the scope of that value (docs/spec/external-sidebars.md#window-tools).
  registry.command("core.sidebar.toggle", invalid(async ({ side }) => {
    if (projects.inHome()) throw new Error("the work screen is not shown");
    const next = !value(side);
    await changeSetting(side, next, appliedPatch(side, next).scope, "core.sidebar.toggle");
  }));
  registry.command("core.settings.theme", async ({ name, mode, scope = "common" }) => {
    // default: when mode is omitted, the current mode is used, and when scope is omitted, the global scope is used (core.settings.theme in exposure.json).
    await applyTheme(name, mode ?? scopedValue("mode", scope), scope, "core.settings.theme");
  });
  registry.command("core.settings.link", invalid(async ({ place, plugin = null, set: choice, scope = "common" }) => {
    if (choice !== "off" && choice !== "inherit" && !scopedValue("sets", scope).some((s) => s.id === choice)) {
      throw new Error(`unknown set ${choice}`);
    }
    await link(place, plugin, choice, scope, "core.settings.link");
  }));
  registry.command("core.settings.sets.create", async ({ scope = "common" }) => {
    const sets = createSet(scopedValue("sets", scope));
    const { id } = sets.at(-1);
    await set({ sets }, scope, "core.settings.sets.create");
    if (settingsTabFront()) await registry.run("core.settings-tab.edit", { set: id });
    return { id };
  });
  registry.command("core.settings.sets.update", invalid(async ({ id, title, layout, scope = "common" }) => {
    // A set name of spaces only is refused with the text that the settings tab shows (docs/spec/settings.md#stored-sets-and-links).
    if (title !== undefined && typeof title === "string" && title.trim() === "") throw new Error("이름이 필요하다.");
    const change = Object.fromEntries(Object.entries({ title, layout }).filter(([, v]) => v !== undefined));
    await set({ sets: updateSet(scopedValue("sets", scope), id, change) }, scope, "core.settings.sets.update");
  }));
  registry.command("core.settings.sets.row", invalid(async ({ id, action, index, section: sectionId, scope = "common" }) => {
    const registered = pluginUnits().flatMap((u) => u.sections);
    await set({ sets: changeRow(scopedValue("sets", scope), id, { action, index, section: sectionId }, registered) }, scope, "core.settings.sets.row");
  }));
  registry.command("core.settings.sets.delete", async ({ id, scope = "common" }) => {
    await set(deleteSet(scopedValue("sets", scope), scopedValue("links", scope), id), scope, "core.settings.sets.delete");
  });
  // The status and the two commands of the settings tab: the tab loads at its first command (settingsUi).
  // default: the status of the settings tab is null while its screen has not loaded.
  registry.status("core.settings-tab", () => settingsScreen?.settingsTabStatus() ?? null, (fn) => {
    tabStatusListeners.add(fn);
    return () => tabStatusListeners.delete(fn);
  });
  registry.command("core.settings.open", async () => { (await settingsUi()).openSettingsTab(); });
  registry.command("core.settings.close", () => { settingsScreen?.closeSettingsTab(); });
  // The debug view is a dialog, so the settings tab closes before it opens.
  registry.command("core.debug.open", onDebug(async (screen) => { settingsScreen?.closeSettingsTab(); await screen.openDebug(); }));
  registry.command("core.debug.close", () => { closeDebug(); });
  registry.command("core.debug.save", onDebug((screen, { path }) => screen.saveDebugFile(path)));
  registry.command("core.debug.save-all", onDebug((screen) => screen.saveDebugFiles()));
  registry.command("core.debug.view", onDebug((screen, { path }) => screen.viewDebugFile(path)));
  registry.command("core.debug.list", onDebug((screen) => { screen.listDebugFiles(); }));
  registry.command("core.debug.state", onDebug((screen, { path }) => screen.showDebugState(path)));
  registry.command("core.debug.state.compare", onDebug((screen, { with: other }) => screen.compareDebugState(other)));
  registry.command("core.debug.timeline", onDebug((screen) => screen.showDebugTimeline()));
  registry.command("core.debug.timeline.filter", onDebug((screen, change) => { screen.filterDebugTimeline(change); }));
  registry.command("core.debug.timeline.follow", onDebug((screen, { on }) => screen.followDebugTimeline(on)));
  registry.command("core.debug.timeline.older", onDebug((screen) => screen.olderDebugTimeline()));
  registry.command("core.debug.timeline.select", onDebug((screen, { row, selected }) => { screen.selectDebugRow(row, selected); }));
  registry.command("core.debug.timeline.context", onDebug((screen, { row }) => screen.contextDebugRow(row)));
  registry.command("core.debug.timeline.save", onDebug((screen) => screen.saveDebugRows()));
  // Shows the project home in this window while keeping the current work.
  registry.command("core.projects.browse", async () => { await projects.showHome(); });
  registry.command("core.projects.flush", async () => { await projects.flush(); });
  registry.command("core.project.open", ({ root, color = "#ffb36b" }) => {
    // The resize marker registered below covers the window size, and this command covers opening a project (V5-104).
    trace("action", { kind: "project.open", root });
    return projects.open({ root, color, layout: fresh() });
  });
  registry.command("core.project.activate", async ({ id }) => { await projects.activate(id); });
  registry.command("core.project.close", async ({ id }) => {
    need(projects.all().find((p) => p.id === id), id);
    return { closed: await projects.close(id) };
  });
  registry.command("core.project.rename", async ({ id, title }) => { await projects.rename(id, title); });
  registry.command("core.project.move", async ({ id, delta }) => { await projects.move(id, delta); });
  registry.command("core.project.pin", async ({ id, pinned }) => { await projects.pin(id, pinned); });
  registry.command("core.window.new", async () => { await projects.newWindow(); });
  registry.command("core.folder.create", ({ parent, name }) => windows.createFolder({ parent, name }));
  registry.command("core.space.add", () => {
    need(projects.active(), "active");
    const { id, title } = projects.addSpace(fresh());
    return { id, title };
  });
  registry.command("core.space.activate", ({ id }) => { projects.activateSpace(id); });
  registry.command("core.space.rename", ({ id, title }) => { projects.renameSpace(id, title); });
  registry.command("core.space.close", async ({ id }) => {
    const project = projects.active();
    // The last space does not close. Only the active space has tabs in the plane, so only it can hold a modified tab.
    if (project.spaces.length === 1) return { closed: false };
    if (id === project.activeSpaceId && !(await settleModifiedTabsToClose())) return { closed: false };
    projects.closeSpace(id);
    return { closed: true };
  });
  registry.command("core.grid.size", ({ card, axis, size }) => {
    const grid = currentGrid();
    if (!grid?.setSize(card, axis, size)) throw new Error(`cannot size ${card} on ${axis}`);
    settle();
  });
  registry.command("core.plugins.install", pluginCommand("install"));
  registry.command("core.plugins.update", pluginCommand("update"));
  registry.command("core.plugins.remove", pluginCommand("remove"));
  registry.command("core.plugins.enable", pluginCommand("enable"));
  registry.command("core.plugins.disable", pluginCommand("disable"));
  registry.command("core.plugins.apply", () => applyPluginChange("core.plugins.apply"));
  registry.command("core.plugins.update-all", () => pluginOperations.updateAll());
  registry.command("core.app.update", () => appUpdate.update());
  registry.command("core.app.release", (params, cause) => appUpdate.openRelease(cause));
  registry.command("core.plugins.replace", async ({ sidecar }) => {
    if (typeof sidecar !== "string" || sidecar === "") {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "sidecar must be a non-empty string");
    }
    await pluginOperations.replace(sidecar);
  });
  registry.command("core.plugins.registry", async ({ index }) => {
    if (typeof index !== "string" || index === "") {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "index must be a non-empty string");
    }
    await pluginOperations.useRegistry(index);
    await appUpdate.refresh();
  });
  // Plugin management opens the installed-plugin page of the settings tab (docs/spec/settings.md#plugins).
  registry.command("core.plugins.browse", async () => {
    await registry.run("core.settings.open", {});
    await registry.run("core.settings-tab.nav", { page: "installed" });
  });
  registry.command("core.plugins.show-updates", async () => {
    await registry.run("core.settings.open", {});
    await registry.run("core.settings-tab.nav", { page: "installed" });
  });

  registry.command("core.card.focus", ({ card }) => { trace("action", { kind: "card.focus", card }); focusCard(card); });
  registry.command("core.card.sidebar.set", ({ card, side, set }) => { assignSidebar(card, side, set); });
  registry.command("core.card.sidebar.toggle", ({ card, side }) => { foldSidebar(card, side); });
  registry.command("core.card.sidebar.size", ({ card, side, size }) => { resizeSidebar(card, side, size); });
  // A section choice hides a section and gives its room to the others, so the plane is laid out again and the compositor publishes the
  // new seats of the section surfaces (docs/spec/plugins.md#sections).
  registry.command("core.sidebar.section.select", ({ sidebar, section }) => { selectSection(sidebar, section); settle(); });
  registry.command("core.sidebar.section.fold", ({ sidebar, section }) => { foldSection(sidebar, section); settle(); });
  registry.command("core.sidebar.section.size", ({ sidebar, heights }) => { sizeSections(sidebar, heights); settle(); });
  registry.command("core.text.larger", async () => { await changeTextSize(1, "core.text.larger"); });
  registry.command("core.text.smaller", async () => { await changeTextSize(-1, "core.text.smaller"); });
  registry.command("core.text.reset", async () => { await changeTextSize(0, "core.text.reset"); });
  registry.command("core.card.fullscreen", ({ card }) => { toggleCardFullscreen(card); });
  registry.command("core.card.menu", ({ card, menu }) => { openCardMenu(card, menu); });
  registry.command("core.card.tab-list", ({ card }) => { openCardTabs(card); });
  registry.command("core.card.tools", ({ card }) => { openCardTools(card); });
  registry.command("core.space.apps", ({ card }) => { openSpaceApps(card); });
  registry.command("core.surface.menu", ({ surface, x, y }) => { openSurfaceMenu(surface, x, y); });
  document.addEventListener("contextmenu", onSurfaceContextMenu);
  registry.command("core.card.add-tab", ({ card, plugin, params }) => ({ tab: addTabTo(card, plugin, params) }));
  registry.command("core.file.place", ({ name }) => filePlace(name));
  registry.command("core.file.open", ({ path, card }) => {
    if (!projects.active()) throw new Error("this window shows no project");
    return openFile(checkOpenPath(path), card);
  });
  registry.command("core.card.split", ({ card, side, plugin }) => splitCard(card, side, plugin));
  registry.command("core.card.close", ({ card }) => closeCard(card));
  // The group commands and the card query of any level (docs/spec/groups.md#commands).
  registry.command("core.group.create", ({ card, side, plugin: kind, params, request }) => createGroup(card, side, kind, params, request));
  registry.command("core.group.dissolve", ({ group }) => dissolveGroup(group));
  registry.command("core.group.rename", ({ group, name }) => renameGroup(group, name));
  registry.command("core.group.leader", ({ card }) => leadLevel(card));
  registry.command("core.group.menu", ({ group }) => openGroupMenu(group));
  registry.command("core.card.move", ({ card, target, side, index }) => moveCard(card, target, side, index));
  registry.command("core.card.get", async ({ card }) => {
    // The card is checked before the window is read, so a refused card reads nothing.
    cardState(card, new Map());
    const reply = await registry.handle({ id: null, method: "exposure.snapshot", params: {} });
    if (reply.error) throw new Error(`core.card.get ${card}: exposure.snapshot: ${reply.error.message}`);
    // The statuses that each surface declares with summary true are the status of its tab (docs/spec/exposure.md#entry-fields).
    const summary = new Map(reply.result.groups.filter((group) => group.owner === "surface")
      // default: a status whose read failed has no value, which is written as null.
      .map((group) => [group.surface, Object.fromEntries(group.status.filter((entry) => entry.summary === true).map((entry) => [entry.name, entry.value ?? null]))]));
    return cardState(card, summary);
  });
  // The layout operations of an agent (docs/spec/cli.md#acting-on-a-layout). Each decides and changes the layout in the turn that runs it.
  registry.command("core.layout.open", (params) => {
    // A tab that shows a session names it in its params, and the session must belong to the plugin of the tab (docs/spec/plugins.md#owned-sessions).
    const session = params.params?.session;
    if (session === undefined) return openInLayout(params);
    if (typeof session !== "string" || session === "") throw new Error("core.layout.open: session must be a session identifier");
    if (params.plugin === undefined) throw new Error("core.layout.open: session requires plugin");
    checkShowOwnedSession(session, params.plugin);
    const placed = openInLayout(params);
    bindShown(session, placed.tab, cardSizeOf(placed.tab));
    return placed;
  });
  registry.command("core.session.open", (params, { surface }) => openOwnedSession(params, surface));
  registry.command("core.session.resize", (params, { surface }) => resizeOwnedSession(params, surface));
  registry.command("core.session.end", (params, { surface }) => endOwnedSession(params, surface));
  registry.command("core.session.input", (params, { surface }) => inputOwnedSession(params, surface));
  registry.command("core.session.submit", (params, { surface }) => submitOwnedSession(params, surface));
  registry.command("core.session.read", (params, { surface }) => readOwnedSession(params, surface));
  registry.command("core.layout.select", (params) => selectInLayout(params));
  registry.command("core.layout.move", (params) => moveInLayout(params));
  registry.command("core.layout.close", (params) => closeInLayout(params));
  // The plan and the apply of a whole arrangement (docs/spec/cli.md#planning-an-arrangement).
  registry.command("core.layout.plan", (params) => planInLayout(params));
  registry.command("core.layout.apply", (params) => applyInLayout(params, applySessionCheck, applySessionShow));
  registry.command("core.tab.select", ({ tab }) => { trace("action", { kind: "tab.select", tab }); selectTab(tab); });
  // The role handshake of a tab (docs/spec/agent-roles.md#change-of-a-running-agent): the ordered change and the confirmation run
  // in the host store; the confirmation names no tab, because it runs on the surface of its caller.
  // The role definitions (docs/spec/agent-roles.md#commands): the host answers the stored definition and notifies every window.
  registry.command("core.role.define", ({ id, text, ko, files }) => projects.roleDefine(id, { text, ko, files }));
  registry.command("core.role.remove", ({ id }) => projects.roleDefinitionRemove(id));
  registry.command("core.tab.role", ({ tab, role }) => projects.rolePut(tab, role));
  registry.command("core.tab.role.confirm", ({ fingerprint }, { surface }) => {
    if (surface === undefined) throw new Error("core.tab.role.confirm requires the surface of its caller");
    return projects.roleConfirm(surface, fingerprint);
  });
  registry.command("core.tab.close", ({ tab }) => closeTabById(tab));
  registry.command("core.tab.unload", async ({ tab }) => {
    await memory.unload(memoryTab(tab));
    return null;
  });
  // The host restarts the view of the tab and refuses a tab without a view with an error that names it.
  registry.command("core.tab.reload", async ({ tab }) => {
    if (typeof tab !== "string") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `unknown tab ${JSON.stringify(tab)}`);
    await reloadView(tab);
    return { tab };
  });
  registry.element("core.tab.reload");
  registry.command("core.tab.keep", ({ tab, keep }) => {
    memoryTab(tab);
    if (typeof keep !== "boolean") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "keep must be a boolean");
    memory.keep(tab, keep);
    return null;
  });
  registry.command("core.tab.menu", ({ tab, x, y }) => { openTabMenu(tab, x, y, tabMenuItems(memoryTab(tab), memory.reasons(tab))); });
  // A right click on a tab button opens its context menu when the menu has items; otherwise the page menu opens.
  document.addEventListener("contextmenu", (event) => {
    const button = event.target.closest(".tab[data-tab-id]");
    if (!button || !memory.known(button.dataset.tabId)) return;
    if (tabMenuItems(button.dataset.tabId, memory.reasons(button.dataset.tabId)).length === 0) return;
    event.preventDefault();
    return registry.run("core.tab.menu", { tab: button.dataset.tabId, x: event.clientX, y: event.clientY });
  });
  registry.command("core.tab.move", ({ tab, card, zone, index }) => moveTab(tab, card, zone, index));
  registry.command("core.picker.pick", ({ index }) => { pickItem(index); });
  registry.command("core.picker.close", () => { closePicker("command"); });
  // Escape in the native menu answers with this command (card.js). The menu is the picker, the only native menu.
  registry.command("core.modal.dismiss", () => { closePicker("dismiss"); });

  registry.command("core.home.show", async () => { await projects.showHome(); });
  // The button back of the project home restores the work screen of the window (docs/spec/projects.md#project-home).
  registry.command("core.home.back", async () => {
    const back = projects.returnable();
    if (back === null) throw new Error("there is no work screen to return to");
    await projects.activate(back.id);
  });
  registry.command("core.home.search", ({ query }) => { home.actions.search(query); });
  registry.command("core.home.search.focus", () => {
    if (!projects.inHome()) throw new Error("the project home is not shown");
    focusElement("core.home.search");
  });
  registry.command("core.home.select", ({ step }) => { home.actions.select(step); });
  registry.command("core.home.open", async ({ project }) => { await home.actions.open(project); });
  registry.command("core.home.form.open", ({ mode, parent }) => { home.actions.openForm(mode, parent); });
  registry.command("core.home.form.set", ({ field, value: input }) => { home.actions.setField(field, input); });
  registry.command("core.home.form.submit", async () => { await home.actions.submitForm(); });
  registry.command("core.home.form.cancel", () => { home.actions.cancelForm(); });
  registry.command("core.home.choose-folder", async () => { await home.actions.chooseFolder(); });
  registry.command("core.home.pin", async ({ project }) => { await home.actions.pin(project); });
  registry.command("core.home.confirm", async ({ project, answer }) => { await home.actions.confirm(project, answer); });
  registry.command("core.home.remove", async ({ project }) => {
    need(projects.all().find((p) => p.id === project), project);
    await home.actions.remove(project);
  });

  registry.command("core.rename.begin", ({ kind, id }) => { renames.begin({ kind, id }); });
  registry.command("core.rename.set", ({ value: input }) => { renames.set(input); });
  registry.command("core.rename.commit", async () => { await renames.commit(); });
  registry.command("core.rename.cancel", () => { renames.cancel(); });
  registry.command("core.focus.set", ({ name, index }) => { focusElement(name, index); });

  registry.command("core.boundary.move", ({ axis, line, position }) => {
    const grid = currentGrid();
    if (!grid?.hasBoundary(axis, line)) throw new Error(`no ${axis} boundary at line ${line}`);
    // The group tree moves the whole line and stops where a card would be drawn below its minimum or the groups would lose their form
    // (docs/spec/groups.md#minimum-size).
    const moved = currentTree().moveBoundary(axis, line, position, false);
    settle();
    return { position: moved };
  });

  registry.command("core.boundary.center", ({ axis, line }) => {
    const grid = currentGrid();
    if (!grid?.hasBoundary(axis, line)) throw new Error(`no ${axis} boundary at line ${line}`);
    // The group tree centres the line, leaves it where a card would be drawn below its minimum and merges the lines that meet
    // (docs/spec/groups.md#commands).
    const centred = currentTree().centerBoundary(axis, line);
    settle();
    return { position: centred };
  });

  // The setting cardArrange chooses the operation: resize keeps the layout and gives every card a fair share
  // (packages/soksak/docs/layout.md#balancing), even replaces it with an equal grid (packages/soksak/docs/layout.md#even-arrangement).
  registry.command("core.layout.balance", () => {
    if (!currentGrid()) throw new Error("the window shows no layout");
    // The group tree balances a space with groups by equal shares, which keep every group card on its rectangle
    // (docs/spec/groups.md#card-commands-on-a-group-card).
    currentTree().balance(value("cardArrange") === "even");
    settle();
  });

  for (const { name } of registry.list().element) {
    if (name.startsWith("core.")) registry.element(name);
  }

  onPicker(coreChanged);
  onSurfaceState(coreChanged);
  onMountedChange(coreChanged);
  onModalState(coreChanged);
  onSaved(coreChanged);

  await connectExposure({ surfacePlugin, preferred, registrationChanged: coreChanged,
    // The owned session that a surface shows, for the record of a status read (workbench.status.read).
    sessionOf: (surface) => ownedSessionsState().find((entry) => entry.shownBy === surface)?.session ?? null, // default: null when the surface shows no owned session, as docs/spec/events.json states for workbench.status.read: "(null when it shows none)".
    // A modal that the command opened holds the input of the window once the host answered its show
    // (docs/spec/native-modals.md#keyboard).
    settled: async () => { await drawn(); await orderedCallsAnswered(); }, report,
    surfaceFrame: (surface) => {
      const record = seated()?.surfaces.find((entry) => entry.id === surface);
      return record ? shift(record.applied, planeOrigin()) : null;
    },
    elementPlace: overlayElementRect, elementInert: behindDialog, unloaded: (surface) => memory.unloaded(surface), leftOut: surfaceLeftOut,
    // The store of the workspace refreshes the core watches of a surface, because a role change of any window notifies it.
    onStoredChange: projects.onStoredWorkspaceChange,
    snapshotParts: () => ({
      layout: layoutDescription(),
      plugins: pluginDescriptions(),
      surfaces: surfacesState().map(({ surface, plugin: owner, kind, visible }) => ({
        surface, plugin: owner, kind, visible, state: memory.unloaded(surface) ? "unloaded" : "loaded",
      })),
    }) });
}

/**
 * The loaded plugins of the window for its snapshot (docs/spec/exposure.md#window-snapshot): {plugin, name, description, surface}, where
 * surface is null for a plugin without a tab surface and otherwise the surface.params schema of its tabs or null and the extensions of
 * surface.opens or [].
 */
function pluginDescriptions() {
  return pluginUnits().map((unit) => {
    if (!unit.surface) return { plugin: unit.id, name: unit.name, description: unit.description, surface: null };
    const { params, opens } = plugin(unit.id);
    // default: a plugin without surface.opens opens no file, which the snapshot lists as no extension.
    return { plugin: unit.id, name: unit.name, description: unit.description, surface: { params, opens: opens ?? [] } };
  });
}

// Action marker for window size changes (V5-104). It marks the log so that an event can be matched to the action that preceded it.
addEventListener("resize", () => {
  trace("action", { kind: "resize", width: innerWidth, height: innerHeight });
});
