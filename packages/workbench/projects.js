// The project list is stored in the shared store; the active project and the window ownership are stored in the running window.
import { issueId } from "./ids.js";
import { forgetTabsLeft } from "./tab-reports.js";
import { beginOperation } from "./operations.js";
import { beginSettings, selectProject, value, flushSettings } from "./settings.js";
import { flushEvents } from "./page-log.js";
import { windows } from "@soksak/runtime";
import { log, retainSidecarSessions, windowSidecar } from "./host.js";
import { commitData, configureData, prepareData, restoreData, showData } from "./plugin-data.js";
import { openTabStates } from "./tab-state.js";
import { createTabSessions } from "./tab-session.js";
import { documentRegions } from "./document-regions.js";

let store;
let projects = [];
let activeProjectId = null;
let browsing = true;
let openProjects = new Set();
const owned = new Set();
let listener;
let changed = () => {};
let savedLayout = "";
let writing = Promise.resolve();
let refreshing = Promise.resolve();
/* Project that was drawn on the first screen and is not activated yet. The activation of initialise takes it over. */
let begun = null;
let initialContextPending = false;
let initialContextFailed = false;
let initialContextPromise = Promise.resolve({ ok: true });
let resolveInitialContext = null;
// The tab state store of the memory saver (docs/spec/projects.md#persistence), opened by initialise.
let tabStates = null;
let tabSessions = null;
// Resolves when initialise has tried to open the tab state store; the first plane is drawn before that, so a surface whose
// plugin declares surface.unload waits for it before its module mounts. A store that failed to open stays null, and the
// tab state of a surface then throws that the store is not open.
let triedTabStates;
const tabStatesTried = new Promise((resolve) => { triedTabStates = resolve; });
let openedTabStates;
const tabStatesOpenResult = new Promise((resolve) => { openedTabStates = resolve; });
let tabStatesOpenSettled = false;

export const all = () => projects;
/** The tab state store of the memory saver. */
export const tabStateStore = () => tabStates;
/** The tab sessions of this window (tab-session.js), or null before the start opened them. */
export const tabSessionStore = () => tabSessions;
/** Resolves once initialise has tried to open the tab state store. */
export const tabStatesReady = () => tabStatesTried;
/** Resolves with whether the tab state store opened; callers that place startup views must reject a failed open. */
export const tabStatesOpened = () => tabStatesOpenResult;
/** Waits until the first project layout has committed its context or has been cleared back to the library. */
export async function waitForInitialProjectContext() {
  const outcome = await initialContextPromise;
  if (!outcome.ok) throw outcome.reason;
}
export const initialProjectContextReady = () => !initialContextPending && !initialContextFailed;
export const initialProjectContextFailed = () => initialContextFailed;

function prepareInitialProjectContext(pending) {
  initialContextPending = pending;
  initialContextFailed = false;
  resolveInitialContext = null;
  if (!pending) {
    initialContextPromise = Promise.resolve({ ok: true });
    return;
  }
  initialContextPromise = new Promise((resolve) => {
    resolveInitialContext = resolve;
  });
}

function finishInitialProjectContext(error, rejected = false) {
  if (!initialContextPending) return;
  initialContextPending = false;
  initialContextFailed = rejected;
  const resolve = resolveInitialContext;
  resolveInitialContext = null;
  resolve(rejected ? { ok: false, reason: error } : { ok: true });
}

/** The tab ids of the layouts of all spaces of project. */
function projectTabs(project) {
  // default: a seat card has null data, so it has no tabs.
  return new Set(project.spaces.flatMap((space) => space.layout.state.cards.flatMap((card) => (card.data?.tabs ?? []).map((tab) => tab.id))));
}

/**
 * Returns the tabs of the layouts of all spaces of all projects as surfaces with the root of their project. A sidecar session of a surface that is not in this list has nowhere to attach again (docs/spec/persistent-services.md).
 */
export function layoutSurfaces() {
  return projects.flatMap((project) => project.spaces.flatMap((space) => {
    const cards = space.layout?.state?.cards;
    if (!Array.isArray(cards)) throw new Error(`project ${project.id} space ${space.id} has no layout cards`);
    // default: a seat card has null data, so it has no tabs.
    return cards.flatMap((card) => (card.data?.tabs ?? []).map((tab) => ({ surface: tab.id, root: project.root })));
  }));
}
// default: a window without an active project (the library) has null.
export const active = () => projects.find((p) => p.id === activeProjectId) ?? null;
export const local = () => projects.filter((p) => owned.has(p.id));
export const inLibrary = () => browsing;
export const isOpen = (id) => openProjects.has(id) || owned.has(id);
/**
 * Finishes the transitions that change the plane (opening the library, activating a project) in the order received.
 *
 * Opening the library waits while the plane is emptied. If an activation started meanwhile filled the plane first, the emptying that finished later would erase the plane of the active project.
 */
let switching = Promise.resolve();
function inTurn(run) {
  const done = switching.then(run);
  // The caller that received done reports a failure (command, library, window activation, start document). The next transition runs regardless of an earlier failure.
  switching = done.then(undefined, () => undefined);
  return done;
}

/*
 * The library state and the screen change together in the drawing that empties the plane (showLibrary). That drawing is an animation frame, which runs before the observation round, so the emptied plane and the visible library appear in one frame, and the transition that hides the work area does not run inside the round. Measured fact: previously this transition ran inside a callback slot of the files tree observer (F43). A path that started a transition in that slot is reported by the diagnostic recorder (resize-loop.js) through the stack of the body dataset write.
 */
function showLibrary() {
  browsing = true;
  changed();
}

/** Empties the plane and shows the library in that drawing. Even if the drawing fails, the transition ends at the library. The layout queue reported the failure. */
async function emptyToLibrary() {
  await listener.empty(showLibrary);
  browsing = true;
}

export function browse() {
  return inTurn(async () => {
    await flush();
    const previous = { id: activeProjectId, browsing };
    try {
      await selectProject(null);
      await publishProjectData(await prepareData(null), null);
    } catch (error) {
      try { await selectProject(previous.browsing ? null : previous.id); } catch (restoreError) { failed(restoreError); }
      throw error;
    }
    await emptyToLibrary();
    changed();
  });
}
export const newWindow = () => windows.newWindow(beginOperation("page.window.operation", { action: "new" }));
export const pin = (id, pinned) => store.patch(id, { pinned });
export function onSwitch(callbacks) { listener = callbacks; }
export function onChange(fn) { changed = fn; }

/** Stores the plugin data key of plugin for project id with value (docs/spec/plugins.md#project-data). */
async function setPluginData(id, plugin, key, value) {
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  // default: a project that never stored plugin data has no plugins.
  const plugins = { ...(project.plugins ?? {}), [plugin]: { ...(project.plugins?.[plugin] ?? {}), [key]: value } };
  await store.patch(id, { plugins });
  project.plugins = plugins;
}

/**
 * Draws the first screen from the snapshot of the start document (docs/spec/native-host.md#page-start): the layout of
 * the active space of the project in the address when the plane can open it, or else the library. The activation of
 * initialise then checks the folder, owns the window and reports its failures.
 */
export function begin(snapshot) {
  // default: the store of the browser example has no other window, so it carries no open.
  openProjects = new Set(snapshot.open ?? []);
  projects = snapshot.projects;
  // default: a window that names no project, or a project that is not in the registry, starts at the library.
  const requested = projects.find((p) => p.id === new URL(location.href).searchParams.get("project")) ?? null;
  const layout = requested?.spaces.find((s) => s.id === requested.activeSpaceId)?.layout;
  let opened = null;
  if (layout) {
    try {
      checkSpace(requested, requested.activeSpaceId);
      opened = requested;
    } catch {
      // silent: for a layout that the plane cannot open, the activation of initialise reports the error and the window stays at the library.
    }
  }
  prepareInitialProjectContext(Boolean(opened));
  // default: when no project was opened, the settings have no project either.
  beginSettings(snapshot, opened?.id ?? null);
  if (!opened) {
    changed();
    return;
  }
  activeProjectId = opened.id;
  browsing = false;
  begun = opened.id;
  // The work area screen gives the plane its size, so the screen changes first and then the plane is drawn. A plane drawn without a size is drawn again on the next frame.
  changed();
  listener.load(layout);
  const recreated = opened.spaces.find((s) => s.id === opened.activeSpaceId);
  const previousRecreated = recreated.layout;
  recreated.layout = listener.save("recreate");
  forgetTabsLeft(previousRecreated.state.cards, recreated.layout.state.cards);
  savedLayout = JSON.stringify({ spaces: opened.spaces, activeSpaceId: opened.activeSpaceId, named: opened.named });
}

/** Starts the project list of the window over storage; unloadOf(plugin) returns the surface.unload declaration of a plugin. */
export async function initialise(storage, unloadOf) {
  try {
    await initialiseWindow(storage, unloadOf);
  } catch (error) {
    finishInitialProjectContext(error, true);
    throw error;
  }
}

async function initialiseWindow(storage, unloadOf) {
  store = storage;
  configureData({
    sidecar: windowSidecar,
    // default: the data of a project that stored no plugin data is empty.
    data: { get: (id, plugin) => projects.find((p) => p.id === id)?.plugins?.[plugin] ?? {}, set: setPluginData },
  });
  await refresh();
  tabSessions = createTabSessions({ store, failed, interaction: (tab) => documentRegions.interaction(tab),
    tabs: () => documentRegions.tabs() });
  documentRegions.useSessions((tab) => tabSessions.read(tab));
  try {
    tabStates = await openTabStates({ store, failed, unloadOf });
    if (!tabStatesOpenSettled) {
      tabStatesOpenSettled = true;
      openedTabStates({ opened: true });
    }
  } catch (error) {
    if (!tabStatesOpenSettled) {
      tabStatesOpenSettled = true;
      openedTabStates({ opened: false, error });
    }
    throw error;
  } finally {
    triedTabStates();
  }
  // A stored layout that cannot be read leaves the tab ids unknown, so the store keeps every entry and the error is
  // shown; opening that project reports the same layout again.
  try {
    const tabIds = new Set(layoutSurfaces().map((item) => item.surface));
    await Promise.all([tabStates.reconcile(tabIds), tabSessions.reconcile(tabIds)]);
  } catch (error) {
    failed(error);
  }
  store.onChange(() => { reread().catch(failed); });
  await windows.onActivate((id) => activateHere(id).catch(failed));
  await windows.onCloseRequest(() => closeWindow().catch(failed));
  await windows.onRemoveProjectRequest((id) => answerRemoval(id).catch(failed));
  const requested = new URL(location.href).searchParams.get("project");
  const first = requested ? projects.find((p) => p.id === requested) : null;
  if (first) {
    try { await activate(first.id); } catch (error) { failed(error); }
  }
  // When the project drawn on the first screen could not be activated, the window returns to the library.
  if (begun !== null && !owned.has(begun)) await leaveBegun();
  begun = null;
  await windows.ready();
  changed();
}

/**
 * Answers the host's request that another window sends before it removes the project id: a window that shows the
 * project in its plane asks for each modified tab first (docs/spec/plugins.md#tab-reports).
 */
async function answerRemoval(id) {
  let allowed = false;
  try {
    allowed = !(id === activeProjectId && !browsing) || await listener.settleTabs();
  } finally {
    await windows.answerRemoveProject(id, allowed);
  }
}

function failed(error) { dispatchEvent(new ErrorEvent("error", { message: error.message })); }

/** Closes the project that was drawn on the first screen but could not be opened, and shows the library. */
async function leaveBegun() {
  activeProjectId = null;
  savedLayout = "";
  history.replaceState(null, "", location.pathname);
  await selectProject(null);
  await emptyToLibrary();
  finishInitialProjectContext();
}

/** Reads the registry again. Resolves true when the active project of this window disappeared from the registry. */
function refresh() {
  refreshing = refreshing.then(readProjects, readProjects);
  return refreshing;
}

/**
 * Reads the registry again, and when the active project of this window disappeared, opens the first remaining project of this window, as closing a project tab does. When no project remains, the window stays at the library that readProjects showed (docs/spec/projects.md#settings). The activation waits for refresh, so it is not done inside readProjects.
 */
async function reread() {
  if (!(await refresh())) return;
  const next = local()[0];
  if (next) await activate(next.id);
}

async function readProjects() {
  const snapshot = await store.snapshot();
  const listed = new Set(snapshot.projects.map((p) => p.id));
  const removedProjects = projects.some((p) => !listed.has(p.id));
  // The cleanup below keeps only the tabs of the stored layouts. If the plane of the remaining active project has tabs that are not stored yet, they are stored first so that their surfaces remain too. The removed project is not stored.
  if (removedProjects && listed.has(activeProjectId)) await keep("saved layout");
  // default: the store of the browser example has no other window, so it carries no open.
  openProjects = new Set(snapshot.open ?? []);
  const previous = new Map(projects.map((p) => [p.id, p]));
  projects = snapshot.projects.map((p) => {
    const old = previous.get(p.id);
    return owned.has(p.id) && old ? { ...p, spaces: old.spaces, activeSpaceId: old.activeSpaceId, named: old.named } : p;
  });
  const removed = [...owned].filter(id => !projects.some(p => p.id === id));
  for (const id of removed) owned.delete(id);
  const ended = activeProjectId !== null && !active();
  if (ended) {
    activeProjectId = null;
    history.replaceState(null, "", location.pathname);
    savedLayout = "";
    await selectProject(null);
    await showData(null);
    await emptyToLibrary();
  } else if (removed.length && !browsing) listener?.update();
  if (removedProjects) {
    // The tabs of a removed project are in no layout. Whether this window removed the project or only showed it, this window first cleans up the surface modules of those surfaces and ends the sidecar sessions. If a module remains, it reopens the ended session, and when the folder of the removed project does not exist, that opening fails (F44). The host keeps the surface sessions of the remaining modules in retain (docs/spec/persistent-services.md).
    const remaining = layoutSurfaces();
    await listener.retain(new Set(remaining.map((item) => item.surface)));
    await retainSidecarSessions(remaining);
  }
  changed();
  return ended;
}

export function keep(path) {
  const project = active();
  if (!project || !listener || browsing) return writing;
  const before = projectTabs(project);
  const space = project.spaces.find((s) => s.id === project.activeSpaceId);
  const previous = space.layout;
  space.layout = listener.save(path);
  // The tabs that the previous stored layout of this space held and the saved one does not hold leave their origins (docs/spec/projects.md#tab-origin).
  forgetTabsLeft(previous.state.cards, space.layout.state.cards);
  const patch = { spaces: project.spaces, activeSpaceId: project.activeSpaceId, named: project.named };
  const key = JSON.stringify(patch);
  if (key === savedLayout) return writing;
  savedLayout = key;
  const copy = structuredClone(patch);
  writing = writing.then(() => store.patch(project.id, copy));
  // The entries of the dropped tabs are removed only after the layout write is confirmed (docs/spec/projects.md#persistence).
  const after = projectTabs(project);
  const dropped = [...before].filter((tab) => !after.has(tab));
  if (dropped.length) {
    writing = Promise.all([tabStates.removeAfter(writing, dropped), tabSessions.removeAfter(writing, dropped)]);
    const retained = layoutSurfaces();
    const retainedWrite = writing.then(() => retainSidecarSessions(retained));
    writing = retainedWrite.then(() => undefined, failed);
    return retainedWrite;
  }
  return writing;
}

function activateHere(id) {
  return inTurn(() => showProject(id));
}

async function showProject(id, prepared = null, openedProject = null, stagedOwner = false) {
  if (id === activeProjectId && !browsing && owned.has(id)) {
    const previous = { id: activeProjectId, browsing };
    try {
      await selectProject(id);
      if (prepared) await publishProjectData(prepared, active());
      else await windows.projectShown(active());
    } catch (error) {
      try { await selectProject(previous.browsing ? null : previous.id); } catch (restoreError) { failed(restoreError); }
      throw error;
    }
    return;
  }
  if (!openedProject) {
    await keep("library replacement");
    await refresh();
  }
  const project = openedProject ?? projects.find((p) => p.id === id); // default: when no opened record was supplied, resolve it from the refreshed project list.
  if (!project) throw new Error(`Unknown project: ${id}`);
  if (!openedProject) checkProject(project);
  const nextContext = prepared ?? await prepareData({ id, root: project.root }); // default: prepare data when the caller did not provide a staged context.
  const previous = { id: activeProjectId, browsing };
  try {
    await selectProject(id);
    await publishProjectData(nextContext, project);
  } catch (error) {
    try { await selectProject(previous.browsing ? null : previous.id); } catch (restoreError) { failed(restoreError); }
    if (stagedOwner) {
      try { await windows.releaseProject(id); } catch (cleanupError) { failed(cleanupError); }
    }
    throw error;
  }
  owned.add(id);
  activeProjectId = id;
  browsing = false;
  history.replaceState(null, "", `${location.pathname}?project=${encodeURIComponent(id)}`);
  changed();
  savedLayout = "";
  listener.load(project.spaces.find((s) => s.id === project.activeSpaceId).layout);
  changed();
  // Replace the start-document preview synchronously before waking mounts that could declare native composition.
  // `presented` also waits for those declarations, so it cannot be the context barrier.
  if (begun === id) finishInitialProjectContext();
  // A project command completes only after the loaded layout has reached the native compositor.
  // If it returned earlier, the previous frame would be exposed to the caller, and a state with empty regions would be reported as a successful project restore.
  await listener.presented();
}

async function publishProjectData(context, project) {
  const previous = commitData(context);
  try {
    await windows.projectShown(project ? { id: project.id, root: project.root, title: project.title } : null);
  } catch (error) {
    restoreData(context, previous);
    throw error;
  }
}

export function activate(id) {
  return inTurn(() => activateInTurn(id));
}

/** Checks whether the plane can open the layout of the active space of the project. On failure it throws the error before it changes the project, the window or the stored records. */
function checkProject(project) {
  checkSpace(project, project.activeSpaceId);
}

/** Checks that the plane can open the stored layout of a space; the error names projects.json and the space. */
function checkSpace(project, id) {
  try {
    listener.check(project.spaces.find((s) => s.id === id).layout);
  } catch (error) {
    throw new Error(`projects.json: project ${project.root} space ${id}: ${error.message}`);
  }
}

async function activateInTurn(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Unknown project: ${id}`);
  checkProject(project);
  // Activating the project drawn on the first screen has no previous project, so the window position is not stored.
  const resumed = begun === id;
  await keep("library replacement");
  if (!resumed) await saveGeometry();
  const folder = await windows.folder(project.root);
  if (folder.identity !== project.identity) throw new Error(`Project directory has changed: ${project.root}`);
  const result = await windows.openProject({
    // default: a project whose window was never closed has no stored window position (null).
    id, root: project.root, geometry: project.geometry ?? null,
    separate: value("projectOpening") === "windows", current: active() && !owned.has(id) ? activeProjectId : null,
  }, beginOperation("page.project.operation", { action: "open", project: id }));
  if (!result.local) {
    if (active()) await showProject(activeProjectId);
    await store.patch(id, { lastOpened: Date.now() });
    return;
  }
  let prepared;
  try {
    prepared = await prepareData({ id, root: project.root });
  } catch (error) {
    if (result.staged) {
      try { await windows.releaseProject(id); } catch (cleanupError) { failed(cleanupError); }
    }
    throw error;
  }
  await showProject(id, prepared, project, result.staged);
  await store.patch(id, { lastOpened: Date.now() });
}

export async function open({ root, color, layout }) {
  if (!root.trim()) throw new Error("Project directory is empty");
  const folder = await windows.folder(root);
  const space = { id: issueId("space"), title: "SPACE1", layout };
  const project = await store.add({
    id: issueId("project"), ...folder, title: folder.root.split(/[\\/]/).filter(Boolean).at(-1), color,
    named: 1, spaces: [space], activeSpaceId: space.id, settings: {},
  });
  await refresh();
  await activate(project.id);
  return project;
}

/**
 * Removes the project id from the registry. The window that shows the project asks for each modified tab first
 * (docs/spec/plugins.md#tab-reports). Resolves false when a kept tab keeps the project.
 */
export async function close(id) {
  // The operation starts with the first host call that carries it out, so a removal that a kept tab refuses leaves no operation.
  let cids = null;
  const operation = () => {
    if (cids === null) cids = beginOperation("page.project.operation", { action: "remove", project: id });
    return cids;
  };
  // The window that shows the project asks here; another window shows it, the host asks that window.
  const asked = id === activeProjectId && !browsing ? await listener.settleTabs() : await windows.askRemoveProject(id, operation());
  if (!asked) return false;
  // The cleanup below keeps the tabs of the stored layouts. If the plane of the active project has tabs that are not stored yet, they are stored first so that their surfaces remain too.
  await keep("saved layout");
  await windows.releaseProject(id, operation());
  owned.delete(id);
  await store.remove(id);
  // Ending the removed project is done by the same readProjects as in other windows. If the change notification of the store read before this refresh, the reread of that notification opens the next project. That activation passes through the same transition order, so the activate below finishes after it.
  await refresh();
  if (active() && !browsing) listener.update();
  if (!active()) {
    const next = local()[0];
    if (next) await activate(next.id);
  }
  return true;
}

export const rename = (id, title) => store.patch(id, { title });
export const move = (id, delta) => store.move(id, delta);

function restore(path) {
  const p = active();
  listener.load(p.spaces.find((s) => s.id === p.activeSpaceId).layout);
  changed();
  keep(path);
}

export function addSpace(layout) {
  const project = active();
  keep("add space");
  const space = { id: issueId("space"), title: `SPACE${++project.named}`, layout };
  project.spaces.push(space);
  project.activeSpaceId = space.id;
  restore("add space");
  return space;
}

export function activateSpace(id) {
  const project = active();
  if (id === project.activeSpaceId) return;
  const space = project.spaces.find((s) => s.id === id);
  if (!space) throw new Error(`Unknown space: ${id}`);
  // If the plane cannot open the layout, it fails before the active space is changed.
  checkSpace(project, space.id);
  keep("saved layout");
  project.activeSpaceId = id;
  restore("saved layout");
}

export function closeSpace(id) {
  const project = active();
  if (project.spaces.length === 1) return;
  const at = project.spaces.findIndex((s) => s.id === id);
  if (at < 0) throw new Error(`Unknown space: ${id}`);
  // Closing the active space opens the next space. If the plane cannot open that layout, it fails before anything is removed.
  const rest = project.spaces.filter((s) => s.id !== id);
  const next = id === project.activeSpaceId ? rest[Math.min(at, rest.length - 1)] : null;
  if (next) checkSpace(project, next.id);
  keep("saved layout");
  const [removed] = project.spaces.splice(at, 1);
  // The tabs of the removed space leave its stored layout, so their origins end (docs/spec/projects.md#tab-origin).
  forgetTabsLeft(removed.layout.state.cards, []);
  if (next) project.activeSpaceId = next.id;
  restore("saved layout");
  // The tabs of the closed space are in no layout, so their sidecar sessions end.
  retainSidecarSessions(layoutSurfaces()).catch(failed);
}

export function renameSpace(id, title) {
  active().spaces.find((s) => s.id === id).title = title;
  keep("saved layout");
}

export async function saveGeometry() {
  const id = activeProjectId;
  if (!id || browsing) return;
  const geometry = await windows.state();
  if (geometry) await store.patch(id, { geometry });
}

/**
 * Saves the projects, the settings, the geometry, the tab sessions and the tab states. The stores exist only after
 * initialise, and the page follows plugin changes and page hiding only after it, so a flush before initialise is a
 * defect of the caller and fails.
 */
export async function flush() {
  if (!tabSessions) throw new Error("projects.flush: the projects are not initialised");
  await keep("saved layout");
  await flushSettings();
  await saveGeometry();
  await tabSessions.flush();
  await tabStates.flush();
}

async function closeWindow() {
  // A modified tab that the person keeps keeps the window open (docs/spec/plugins.md#tab-reports).
  if (!(await listener.settleTabs())) {
    await windows.closeKept(beginOperation("page.window.operation", { action: "close_kept" }));
    return;
  }
  await flush();
  // The operation starts before the drain: its first event must be in the queue that the drain hands to the writer of the
  // host, because the call ends the page and the host refuses a batch of a window that is gone (F161.26).
  const cids = beginOperation("page.window.operation", { action: "close" });
  await flushEvents();
  await windows.close(cids);
}
