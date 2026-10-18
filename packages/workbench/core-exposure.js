// Exposed entries of the core. Registers the status, command and dom entries that exposure.json declares in the registry.
//
// Values are read from the state that modules hold and from the elements of the document. No entry runs arbitrary code.
//
// A change of a status is announced by calling coreChanged(). The document calls it after the render of the
// plane, after changes of projects and settings, and after the drawing of modals and the library; the
// registry sends only the watched values that changed to the host.
import { contributionsState, onContributionsChange } from "./contributions.js";
import { checkOpenPath } from "./file-open.js";
import { registry, connectExposure, revisitRegistrations, whenRepliesSent } from "./exposure.js";
import { log, reloadPage, report } from "./host.js";
import { createPluginApply } from "./plugin-apply.js";
import { trace } from "./performance.js";
import { focusName, focusState } from "./focus-state.js";
import { trackPointer } from "./pointer-state.js";
import { tabMenuItems } from "./tab-menu.js";
import { EXPOSURE_ERRORS, ExposureError } from "@soksak/plugin-api";
import * as projects from "./projects.js";
import {
  activeTab, addTabTo, assignSidebar, openFile, capture, cardActs, cardTextSizes, changeTextSize, closeCard, closePicker, closeTabById,
  currentGrid, currentTextScope, dragState, focusCard, foldSidebar,
  focused, fresh, fullscreenCard, moveTab, presentedCardRect, toggleCardFullscreen, onPicker, onSurfaceState, openCardMenu, openCardTabs, openCardTools, openSpaceApps, openSurfaceMenu, openTabMenu, onSurfaceContextMenu, pickItem, pickerState, plane, railState, selectTab,
  cardSidebars, resizeSidebar, settle, settleModifiedTabs, settleModifiedTabsToClose, splitCard, surfaceState, tabsOf,
} from "./plane.js";
import {
  applyTheme, defaults, link, onSaved, overridden, reset, saving, scopedValue, set, setDebug, settingProject, THEMES, value,
} from "./settings.js";
import {
  closeSettings, editSet, moveSettings, onSettingsDrawn, openSettings, settingsModalState, searchPlugins, showPlugin, showScope, showSection,
} from "./settings-ui.js";
import { closeDebug, compareDebugState, contextDebugRow, debugState, filterDebugTimeline, followDebugTimeline, listDebugFiles, olderDebugTimeline, onDebugDrawn, openDebug, saveDebugFile, saveDebugFiles, saveDebugRows, selectDebugRow, showDebugState, showDebugTimeline, viewDebugFile } from "./debug-ui.js";
import { changeRow, createSet, deleteSet, updateSet } from "./sidebar-sets.js";
import { pluginUnits } from "./environment.js";
import { latest, seated } from "./compositor.js";
import { filePlace, modalState, onFilesDropped, onModalState } from "./host.js";
import { plugin } from "./registry.js";
import { systemNotifications } from "./system-notifications.js";
import { windows } from "@soksak/runtime";
import { audit, onBinding } from "./commands.js";
import { onTextScope } from "./text-size.js";
import { foldSection, onSectionsChange, selectSection, sidebarsState } from "./sidebar-sections.js";
import { onTabReports, tabError, tabFooter, tabLabel, tabModified, tabNotice } from "./tab-reports.js";
import { appUpdate, followActivation, followPluginChanges, followSidecarChanges, onPluginOperations, pluginOperations } from "./installed-plugins.js";

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
    for (const run of watchers) run();
  });
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
  settle: settleModifiedTabs, flush: projects.flush, reload: () => whenRepliesSent().then(reloadPage),
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
  return async ({ plugin }) => {
    if (typeof plugin !== "string" || plugin === "") {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "plugin must be a non-empty string");
    }
    await pluginOperations.run(action, plugin);
  };
}

/** Registers one core status. The value is read again when coreChanged is called. */
function status(name, read) {
  registry.status(name, read, (fn) => {
    const run = () => fn(read());
    watchers.add(run);
    return () => watchers.delete(run);
  });
}

let verified = null;

/** Records the last verification result. */
export function setVerify(rows) {
  verified = { failed: rows.filter((row) => !row.ok).length, rows };
  coreChanged();
}

const planeOrigin = () => {
  const r = plane.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

const shift = (rect, origin) => ({ x: rect.x + origin.x, y: rect.y + origin.y, w: rect.w, h: rect.h });

/** Finds the plugin of a surface among the tabs of the active space and the tabs of the stored spaces. */
function surfacePlugin(surface) {
  // default: there is no card before the plane is created.
  for (const card of currentGrid()?.cards ?? []) {
    const tab = tabsOf(card).find((t) => t.id === surface);
    if (tab) return tab.plugin;
  }
  for (const project of projects.local()) {
    for (const space of project.spaces) {
      for (const card of space.layout.state.cards) {
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
  const rects = grid.rects();
  const fullscreen = fullscreenCard();
  let pane = 0;
  const cards = [...plane.querySelectorAll(".card[data-card-id]")].map((el) => {
    const card = grid.card(el.dataset.cardId);
    if (!card) return null;
    const rect = fullscreen === null ? rects.get(card.id) : presentedCardRect(card.id);
    const tabs = tabsOf(card);
    return {
      fullscreen: card.id === fullscreen,
      id: card.id, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      c0: card.c0, c1: card.c1, r0: card.r0, r1: card.r1,
      // default: a card without a fixed px width has null width.
      fixed: Boolean(card.fixed), width: card.width ?? null, focused: card.id === focused(),
      pane: el.querySelector(".chrome__acts") ? pane++ : null,
      tabs: tabs.map(({ id, plugin, title }) => ({ id, plugin, title, label: tabLabel(id), notice: tabNotice(id), footer: tabFooter(id),
        modified: tabModified(id), error: tabError(id) })),
      // Text that the content footer shows (docs/spec/example-model.md). default: a card that is not drawn yet has no footer text element, so the text is empty.
      status: el.querySelector(":scope > .status .status__text")?.textContent ?? "",
      active: tabs.length ? activeTab(card).id : null,
      acts: cardActs(card.id),
      sidebars: cardSidebars(card, presentedCardRect(card.id)),
    };
  }).filter(Boolean);
  const lines = (axis) => grid.lines(axis).map((_, k) => grid.boundaryPos(axis, k));
  return {
    fullscreen,
    width: grid.width, height: grid.height, gap: grid.gap, plane: planeOrigin(),
    lines: { x: lines("x"), y: lines("y") }, cards,
  };
}

/* The memory saver of the page (memory-saver.js), given at installCoreExposure. */
let memory = null;

/** The tab of a core.tab command: a string that the memory saver knows, otherwise invalid params. */
function memoryTab(tab) {
  if (typeof tab !== "string" || !memory.known(tab)) {
    throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `unknown tab ${JSON.stringify(tab)}`);
  }
  return tab;
}

function surfacesState() {
  // The tab of a plugin that is not loaded shows a placeholder instead of a surface, and the placeholder reports the reason (docs/spec/plugins.md).
  const placeholders = [...document.querySelectorAll("[data-plugin-placeholder]")].map((el) => ({
    surface: el.dataset.surfaceId, plugin: el.dataset.plugin, visible: true, placeholder: el.dataset.pluginPlaceholder,
  }));
  const record = seated();
  if (!record) return placeholders;
  const at = planeOrigin();
  return [...record.surfaces.map((s) => ({
    surface: s.id, plugin: s.plugin, visible: s.visible, dim: s.dim,
    declared: shift(s.declared, at), applied: shift(s.applied, at),
    exposes: registry.namesOf(s.id), status: surfaceState(s.id), placeholder: null,
    state: memory.unloaded(s.id) ? "unloaded" : "loaded",
  })), ...placeholders];
}

const withOpen = (project) => ({ ...project, open: projects.isOpen(project.id) });

/** Gives keyboard focus to the element of a dom name. */
function focusElement(name, index = 0) {
  if (!registry.list().dom.some((entry) => entry.name === name)) throw new Error(`unknown dom ${name}`);
  const el = document.querySelectorAll(`[data-expose="${name}"]`)[index];
  if (!el) throw new Error(`dom ${name} has no element at index ${index}`);
  el.focus();
}

/** Changes one setting to the input value. A control gives a string, so it is converted to the type of the current value. */
function changeSetting(key, input, scope, actor) {
  if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting: ${key}`);
  // default: scope is an optional parameter, and when it is omitted the global scope is used (core.settings.change in exposure.json).
  const now = scopedValue(key, scope ?? "common");
  const next = typeof now === "boolean" ? input === true || input === "true"
    : typeof now === "number" ? Number(input) : String(input);
  if (typeof now === "number" && !Number.isFinite(next)) throw new Error(`${key} requires a number`);
  return set({ [key]: next }, scope, actor);
}

function need(project, id) {
  if (!project) throw new Error(`Unknown project: ${id}`);
  return project;
}

/**
 * Registers the core entries and connects the registry to the host.
 *
 *   library  return value of createLibrary
 */
/**
 * drawn returns a promise that is fulfilled when the plane has finished all scheduled drawing. A core command waits for that drawing after it ran and then replies. When a command changes the layout, the receiver of the reply reads the layout that is already drawn.
 */
export async function installCoreExposure({ library, renames, chrome, drawn, memorySaver }) {
  memory = memorySaver;
  status("core.window.document", () => ({
    timeOrigin: performance.timeOrigin,
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
    modal: settingsModalState().open ? "settings" : debugState().open ? "debug" : pickerState().open ? "picker" : null,
  }));
  status("core.page.audit", () => ({ unbound: audit(document.body) }));
  // WebKit stops animation frames when it hides the document, so a change of the visibility state is announced.
  document.addEventListener("visibilitychange", coreChanged);
  onBinding(coreChanged);
  // default: core.page.error of a document that shows no error is null (exposure.json).
  status("core.page.error", () => document.getElementById("applicationError")?.textContent ?? null);
  status("core.projects", () => projects.all().map(withOpen));
  status("core.project", () => {
    const project = projects.active();
    return project && !projects.inLibrary() ? withOpen(project) : null;
  });
  status("core.layout", () => (currentGrid() ? capture() : null));
  status("core.grid", gridState);
  status("core.sidebars", sidebarsState);
  onSectionsChange(coreChanged);
  onPluginOperations(coreChanged);
  followSidecarChanges();
  followActivation();
  onTabReports(coreChanged);
  status("core.surfaces", surfacesState);
  status("core.tab.memory", () => ({ enabled: value("memorySaver"), delay: value("memorySaverDelay"), ...memory.status() }));
  status("core.drop", () => lastDrop);
  status("core.notifications", () => systemNotifications.state());
  systemNotifications.onChange(coreChanged);
  onFilesDropped((drop) => { dropFiles(drop).then(coreChanged); });
  status("core.settings", () => ({
    values: Object.fromEntries(Object.keys(defaults).map((key) => [key, value(key)])),
    project: settingProject(),
    overridden: Object.keys(defaults).filter(overridden),
    saving: saving(),
  }));
  status("core.themes", () => THEMES);
  status("core.settings-modal", settingsModalState);
  status("core.debug", debugState);
  status("core.contributions", contributionsState);
  onContributionsChange(coreChanged);
  status("core.plugins", () => pluginOperations.status());
  status("core.app", () => appUpdate.status());
  status("core.picker", pickerState);
  status("core.library", () => library.state());
  status("core.verify", () => verified);
  status("core.modal", modalState);
  status("core.drag", dragState);
  status("core.rename", renames.state);
  status("core.focus", () => focusState(document));
  status("core.pointer", trackPointer(document, coreChanged));
  // Observation of document focus transitions (V5-114). The terminal region is click-transparent, so a press makes the document take focus back, and the address bar that remained as activeElement can receive focus and become visible at that moment. Every transition leaves one line in the performance trace and the diagnostic log and announces core.focus. The elements of a surface are inside a shadow root, so the name is read from the actual target of the event.
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

  registry.command("core.settings.set", async ({ patch, scope }) => {
    try {
      await set(patch, scope, "core.settings.set");
    } catch (error) {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, error.message);
    }
  });
  registry.command("core.settings.reset", async ({ key }) => { await reset(key, "core.settings.reset"); });
  registry.command("core.settings.debug", async ({ on }) => {
    if (typeof on !== "boolean") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "on must be a boolean");
    await setDebug(on, "core.settings.debug");
  });
  registry.command("core.settings.change", async ({ key, value: input, scope }) => {
    await changeSetting(key, input, scope, "core.settings.change");
  });
  registry.command("core.settings.theme", async ({ name, mode, scope }) => {
    // default: when mode is omitted, the current mode is used, and when scope is omitted, the global scope is used (core.settings.theme in exposure.json).
    await applyTheme(name, mode ?? scopedValue("mode", scope ?? "common"), scope, "core.settings.theme");
  });
  // A refusal of a sidebar selection or a set change is an invalid request argument (docs/spec/settings.md).
  const invalid = (run) => async (params) => {
    try {
      return await run(params);
    } catch (error) {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, error.message);
    }
  };
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
    if (settingsModalState().open) editSet(id);
    return { id };
  });
  registry.command("core.settings.sets.update", invalid(async ({ id, title, layout, scope = "common" }) => {
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
  registry.command("core.settings.open", () => { closeDebug(); openSettings(); });
  registry.command("core.settings.close", () => { closeSettings(); });
  // The debug view and the settings modal are both dialogs, and the host shows one native modal at a time.
  registry.command("core.debug.open", async () => { closeSettings(); await openDebug(); });
  registry.command("core.debug.close", () => { closeDebug(); });
  registry.command("core.debug.save", ({ path }) => saveDebugFile(path));
  registry.command("core.debug.save-all", () => saveDebugFiles());
  registry.command("core.debug.view", ({ path }) => viewDebugFile(path));
  registry.command("core.debug.list", () => { listDebugFiles(); });
  registry.command("core.debug.state", ({ path }) => showDebugState(path));
  registry.command("core.debug.state.compare", ({ with: other }) => compareDebugState(other));
  registry.command("core.debug.timeline", () => showDebugTimeline());
  registry.command("core.debug.timeline.filter", (change) => { filterDebugTimeline(change); });
  registry.command("core.debug.timeline.follow", ({ on }) => followDebugTimeline(on));
  registry.command("core.debug.timeline.older", () => olderDebugTimeline());
  registry.command("core.debug.timeline.select", ({ row, selected }) => { selectDebugRow(row, selected); });
  registry.command("core.debug.timeline.context", ({ row }) => contextDebugRow(row));
  registry.command("core.debug.timeline.save", () => saveDebugRows());
  // The project list shows the projects page of the library.
  registry.command("core.projects.browse", async () => {
    await projects.browse();
    library.actions.page("projects");
  });
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
  registry.command("core.settings-modal.nav", ({ section }) => { showSection(section); });
  registry.command("core.settings-modal.scope", ({ scope }) => { showScope(scope); });
  registry.command("core.settings-modal.plugin", ({ plugin: id = null }) => { showPlugin(id); });
  registry.command("core.settings-modal.search", ({ query }) => { searchPlugins(query); });
  registry.command("core.plugins.install", pluginCommand("install"));
  registry.command("core.plugins.update", pluginCommand("update"));
  registry.command("core.plugins.remove", pluginCommand("remove"));
  registry.command("core.plugins.enable", pluginCommand("enable"));
  registry.command("core.plugins.disable", pluginCommand("disable"));
  registry.command("core.plugins.apply", () => applyPluginChange());
  registry.command("core.plugins.update-all", () => pluginOperations.updateAll());
  registry.command("core.app.update", () => appUpdate.update());
  registry.command("core.app.release", () => appUpdate.openRelease());
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
  // Plugin management closes the settings window and shows the plugins page of the library.
  registry.command("core.plugins.browse", async () => {
    closeSettings();
    if (!projects.inLibrary()) await projects.browse();
    library.actions.page("plugins");
  });
  registry.command("core.plugins.show-updates", async () => {
    closeSettings();
    if (!projects.inLibrary()) await projects.browse();
    library.actions.showUpdates();
  });
  registry.command("core.settings-modal.edit", ({ set: id = null }) => { editSet(id); });
  registry.command("core.settings-modal.move", ({ dx, dy }) => { moveSettings(dx, dy); });

  registry.command("core.card.focus", ({ card }) => { trace("action", { kind: "card.focus", card }); focusCard(card); });
  registry.command("core.card.sidebar.set", ({ card, side, set }) => { assignSidebar(card, side, set); });
  registry.command("core.card.sidebar.toggle", ({ card, side }) => { foldSidebar(card, side); });
  registry.command("core.card.sidebar.size", ({ card, side, size }) => { resizeSidebar(card, side, size); });
  registry.command("core.sidebar.section.select", ({ sidebar, section }) => { selectSection(sidebar, section); });
  registry.command("core.sidebar.section.fold", ({ sidebar, section }) => { foldSection(sidebar, section); });
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
  registry.command("core.tab.select", ({ tab }) => { trace("action", { kind: "tab.select", tab }); selectTab(tab); });
  registry.command("core.tab.close", ({ tab }) => closeTabById(tab));
  registry.command("core.tab.unload", async ({ tab }) => {
    await memory.unload(memoryTab(tab));
    return null;
  });
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
  registry.command("core.tab.move", ({ tab, card, zone }) => { moveTab(tab, card, zone); });
  registry.command("core.picker.pick", ({ index }) => { pickItem(index); });
  registry.command("core.picker.close", () => { closePicker(); });

  registry.command("core.library.page", ({ page }) => { library.actions.page(page); });
  registry.command("core.library.plugins.search", ({ query }) => { library.actions.searchPlugins(query); });
  registry.command("core.library.search", ({ query }) => { library.actions.search(query); });
  registry.command("core.library.sort", ({ order }) => { library.actions.sort(order); });
  registry.command("core.library.open", async ({ id }) => { await library.actions.open(id); });
  registry.command("core.library.pin", async ({ id, pinned }) => { await library.actions.pin(id, pinned); });
  registry.command("core.library.remove", async ({ id }) => {
    need(projects.all().find((p) => p.id === id), id);
    await library.actions.remove(id);
  });
  registry.command("core.library.window", async () => { await library.actions.newWindow(); });
  registry.command("core.library.return", async () => { await library.actions.back(); });
  registry.command("core.library.form.open", ({ mode }) => { library.actions.openForm(mode); });
  registry.command("core.library.form.cancel", () => { library.actions.cancelForm(); });
  registry.command("core.library.form.set", ({ field, value: input }) => { library.actions.setField(field, input); });
  registry.command("core.library.form.submit", async () => { await library.actions.submitForm(); });
  registry.command("core.library.choose-folder", async () => { await library.actions.chooseFolder(); });

  registry.command("core.rename.begin", ({ kind, id }) => { renames.begin({ kind, id }); });
  registry.command("core.rename.set", ({ value: input }) => { renames.set(input); });
  registry.command("core.rename.commit", async () => { await renames.commit(); });
  registry.command("core.rename.cancel", () => { renames.cancel(); });
  registry.command("core.focus.set", ({ name, index }) => { focusElement(name, index); });

  registry.command("core.boundary.move", ({ axis, line, position }) => {
    const grid = currentGrid();
    if (!grid?.hasBoundary(axis, line)) throw new Error(`no ${axis} boundary at line ${line}`);
    const moved = grid.moveBoundary(axis, line, position, false);
    settle();
    return { position: moved };
  });

  // Keeps the layout and gives every card a fair share (packages/soksak/docs/layout.md#balancing).
  registry.command("core.layout.balance", () => {
    const grid = currentGrid();
    if (!grid) throw new Error("the window shows no layout");
    if (!grid.balance()) throw new Error("the layout is not slicing");
    settle();
  });

  for (const { name } of registry.list().dom) {
    if (name.startsWith("core.")) registry.dom(name);
  }

  onPicker(coreChanged);
  onSurfaceState(coreChanged);
  onSettingsDrawn(coreChanged);
  onDebugDrawn(coreChanged);
  onModalState(coreChanged);
  onSaved(coreChanged);

  await connectExposure({ surfacePlugin, preferred, registrationChanged: coreChanged, settled: drawn, report,
    unloaded: (surface) => memory.unloaded(surface) });
}

// Action marker for window size changes (V5-104). It marks the log so that an event can be matched to the action that preceded it.
addEventListener("resize", () => {
  trace("action", { kind: "resize", width: innerWidth, height: innerHeight });
});
