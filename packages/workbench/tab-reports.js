import { checkNotice, checkNoticeDone, checkNoticeProgress, isLocalAbsolutePath, originFault } from "@soksak/plugin-api";
import { log, report } from "./host.js";
import { createNotices } from "./notices.js";
import { onSettingsChange, value as settingValue } from "./settings.js";
import { tabName } from "./card-data.js";
import { mapStateCards, stateCards } from "./layout-tree.js";
import { hasPlugin, plugin } from "./registry.js";

// The tab title, the bottom text, and the working directory that a surface reported (docs/spec/plugins.md#tab-reports). They are not stored in the layout.
const labels = new Map();
const footers = new Map();
const directories = new Map();
const origins = new Map();
// The origin that the layout stored for each tab restored from it: {origin} with the stored value, or null when a view tab stored no member.
const loaded = new Map();
// The text of the refusal of a restored view tab whose origin fails the validator (docs/spec/native-surfaces.md#view-surfaces).
const refusals = new Map();
// The path that created each tab id, and the tab ids whose origin this session recorded: the history that the refusal of a missing origin names.
const createdBy = new Map();
const everHeld = new Set();
// The operation whose stored layout last dropped the origin of each tab id (forgetTabsLeft), which the refusal of a missing origin names.
const forgottenBy = new Map();
// The tabs that left their stored layout while their surface was mounted, with the operation that stored the layout that left them.
// Their origin ends when the surface is disposed (settleLeftTabs). A tab that returns to a stored layout leaves this map.
const leftWhileMounted = new Map();
// Whether the surface of a tab id is mounted and not disposed. The page sets it (setMountedTab) because the surface modules import this module.
let mountedTab = () => false;
// The notices of the tabs (docs/spec/notifications.md). The store keeps them; a system notice of a tab also keeps its text here until the tab is
// visible, because only that text is posted as an operating system notification (system-notifications.js).
const systemNotices = new Map();
const modified = new Set();
const errors = new Map();
// The tabs whose surface reports work in progress through context.tab.keep("busy", true) (docs/spec/plugins.md#memory-saver).
const busy = new Set();
// The state of each tab that the memory saver does not hold loaded: unloaded or restoring (docs/spec/exposure.md#tab-memory).
const memoryStates = new Map();
const MEMORY_STATES = new Set(["loaded", "unloaded", "restoring"]);
// The plane tells whether a tab is visible (whether it is the active tab of the focused card).
let visibleTab = () => false;
// The entry watchers are notified on every change of a notice; the toast watchers only when the shown toasts change.
const listeners = new Set();
const toastListeners = new Set();
// The shown toasts as the toast watchers last saw them: the toasts of the store start empty.
let shownToasts = "[]";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// The state of the shown toasts that the toast watchers draw: the id, kind, title, count, text and actions of each. The remaining time is
// left out, because the store changes it without a change of the toasts.
const toastState = () => JSON.stringify([noticeStore.toastStatus().listOpen, noticeStore.toasts().map((toast) => {
  const notice = noticeStore.notice(toast.id);
  return [toast.id, toast.kind, toast.title, toast.count, notice.text, noticeStore.toastActions(toast.id)];
})]);

function notify() {
  for (const listener of listeners) listener();
  const now = toastState();
  if (now === shownToasts) return;
  shownToasts = now;
  for (const listener of toastListeners) listener();
}

/**
 * Creates a notice store (notices.js) of the page. view supplies setTimeout and clearTimeout, now reads the instant, record(level, line)
 * takes each application log record and onChange runs after each change. The page store passes globalThis, Date.now, the host log and
 * notify; a test passes its own clock and its own sinks, and the error display (shown-errors.js) runs on either store.
 */
export function createPageNotices({ view, now, record, onChange }) {
  return createNotices({ settings: (key) => settingValue(key), view, now, log: record, onChange });
}

/** The clock of the page store: now() is the instant of each notice change and timer. A test replaces now with its page clock. */
export const pageClock = { now: () => Date.now() };

const noticeStore = createPageNotices({
  view: globalThis,
  now: () => pageClock.now(),
  record: (level, line) => (level === "error" ? report(line) : log(line)),
  onChange: () => notify(),
});

/** Sets (text) or clears (null) the title that the surface of the tab id shows. */
export function reportTitle(tabId, text) {
  if (text === null) {
    if (labels.delete(tabId)) notify();
    return;
  }
  if (typeof text !== "string" || text.length === 0 || text.length > 256 || CONTROL.test(text)) {
    throw new TypeError("a tab title must be 1 to 256 characters without control characters");
  }
  if (labels.get(tabId) === text) return;
  labels.set(tabId, text);
  notify();
}

/** Records whether the surface of tabId holds unsaved changes (docs/spec/plugins.md#tab-reports). */
export function reportModified(tabId, value) {
  if (typeof value !== "boolean") throw new TypeError("a modified state must be true or false");
  if (modified.has(tabId) === value) return;
  if (value) modified.add(tabId);
  else modified.delete(tabId);
  notify();
}

/** Whether the surface of tabId holds unsaved changes. */
export const tabModified = (tabId) => modified.has(tabId);

/** Shows the operation error text of the surface of tabId, or removes it with null (docs/spec/plugins.md#tab-reports). */
export function reportError(tabId, text) {
  if (text === null) {
    if (errors.delete(tabId)) notify();
    return;
  }
  if (typeof text !== "string" || text.length === 0 || text.length > 1024 || CONTROL.test(text)) {
    throw new TypeError("a tab error must be 1 to 1024 characters without control characters, or null");
  }
  if (errors.get(tabId) === text) return;
  errors.set(tabId, text);
  notify();
}

// default: a tab whose surface reported no error has none.
export const tabError = (tabId) => errors.get(tabId) ?? null;

/** Sets the function with which the page decides whether the surface of a tab is mounted and not disposed. */
export function setMountedTab(probe) {
  mountedTab = probe;
}

/** Ends the origins of the tabs that left their stored layout while mounted, for each surface that is no longer mounted. Called on each mount change. */
export function settleLeftTabs() {
  for (const [tabId, operation] of leftWhileMounted) {
    if (mountedTab(tabId)) continue;
    leftWhileMounted.delete(tabId);
    dropOrigin(tabId, operation);
  }
}

/** Sets the function with which the plane decides whether a tab is visible. */
export function setVisibleTab(probe) {
  visibleTab = probe;
}

/**
 * Shows a notice of a tab of a plugin, checked with the notice rule of the plugin api, and returns its id (docs/spec/plugins.md#tab-reports).
 * A notice with system true is also kept for an operating system notification while its tab is not visible.
 */
export function reportNotice(tabId, fields, plugin) {
  // A tab that no card holds has no card notice; the refusal names the tab (docs/spec/notifications.md#notice-center).
  const target = noticeTargetOfTab(tabId);
  if (target === null) throw new Error(`no tab ${tabId}`);
  const id = noticeStore.showTab(fields, { card: target.card, tab: tabId, plugin, label: target.label });
  // A later notice of the tab, system or not, replaces the kept system notice of the tab (docs/spec/plugins.md#tab-reports).
  if (fields.system === true) keepSystemNotice(tabId, fields);
  else if (systemNotices.delete(tabId)) notify();
  return id;
}

// A system notice is kept under its tab, or under its plugin for a page notice, while it is not visible (docs/spec/notifications.md#plugin-notices).
function keepSystemNotice(tabId, fields) {
  if (visibleTab(tabId)) systemNotices.delete(tabId);
  else systemNotices.set(tabId, fields.text === "" ? fields.title : `${fields.title}\n${fields.text}`);
  notify();
}

/**
 * Shows a notice of a page of a plugin that belongs to no card, checked with the notice rule of the plugin api, and returns its id.
 * Its source is the plugin, and a system notice is kept under the plugin id (docs/spec/notifications.md#plugin-notices).
 */
export function reportPageNotice(fields, plugin) {
  const checked = checkNotice(fields);
  const id = noticeStore.show({ kind: checked.kind, title: checked.title, text: checked.text, source: { kind: "plugin", plugin },
    actions: checked.action ? [checked.action] : [], progress: checked.kind === "progress" ? null : undefined });
  if (checked.system === true) keepSystemNotice(plugin, checked);
  return id;
}

/** Sets the progress of a progress notice of a tab (docs/spec/notifications.md#plugin-notices). */
export function reportProgress(id, progress) {
  const checked = checkNoticeProgress({ id, progress });
  noticeStore.progress(checked.id, checked.progress);
}

/** Ends a progress notice of a tab as success or error (docs/spec/notifications.md#plugin-notices). */
export function reportDone(id, kind, title) {
  const checked = checkNoticeDone({ id, kind, title });
  noticeStore.done(checked.id, checked.kind, checked.title);
}


// The plane tells the card, tab and plugin of a tab id, or null when no card holds it.
let targetOfTab = () => null;

/** Sets the probe with which the plane tells the card, tab and plugin of a tab id. */
export function setTargetOfTab(probe) {
  targetOfTab = probe;
}

/** The notice target {card, tab, plugin} of a tab id, or null when no card holds the tab (docs/spec/notifications.md#card-status-line). */
export function noticeTargetOfTab(tabId) {
  return targetOfTab(tabId);
}

/** Withdraws the notices of a card that has the focus, which the plane reports when the focus moves (docs/spec/notifications.md#places). */
export function reportFocusedCard(card) {
  noticeStore.focusCard(card);
}

/** The bell and the notice center of the window (docs/spec/notifications.md). */
// A change of the problem toast settings restarts or cancels the deadlines of the shown toasts (docs/spec/notifications.md#settings). The
// subscription starts at the first use of the store, because the settings module may still be loading when this module evaluates.
let settingsWatched = false;
export const notificationStore = () => {
  if (!settingsWatched) {
    settingsWatched = true;
    onSettingsChange(() => noticeStore.settingsChanged());
  }
  return noticeStore;
};

// default: a tab without a shown notice is null; otherwise the newest shown notice of the tab as its title and text.
/** The list of [tab id, text] of the system notices whose tab is not visible. */
export const tabNotices = () => [...systemNotices];

/** Removes the system notice of a tab that became visible. The plane calls it on every drawing. */
export function clearVisibleNotices() {
  let removed = false;
  for (const tabId of [...systemNotices.keys()]) {
    if (visibleTab(tabId)) removed = systemNotices.delete(tabId) || removed;
  }
  if (removed) notify();
}

/** Sets (text) or clears (null) the text that the surface of the tab id shows in the footer of the card content. */
export function reportFooter(tabId, text) {
  if (text === null) {
    if (footers.delete(tabId)) notify();
    return;
  }
  if (typeof text !== "string" || text.length === 0 || text.length > 1024 || CONTROL.test(text)) {
    throw new TypeError("a tab footer must be 1 to 1024 characters without control characters");
  }
  if (footers.get(tabId) === text) return;
  footers.set(tabId, text);
  notify();
}

// default: a tab that did not report bottom text is null.
export const tabFooter = (tabId) => footers.get(tabId) ?? null;

/** Records (path) or clears (null) the working directory of the surface of the tab id. */
export function reportDirectory(tabId, path) {
  if (path === null) {
    directories.delete(tabId);
    return;
  }
  if (typeof path !== "string" || !isLocalAbsolutePath(path)) {
    throw new TypeError("a tab directory must be an absolute path");
  }
  directories.set(tabId, path);
}

// default: a tab that did not report a title is null.
export const tabLabel = (tabId) => labels.get(tabId) ?? null;

/**
 * The origin of a new tab: the directory that the source tab recorded at that moment. The caller passes null when there is no source
 * tab. A source tab that recorded no directory gives null, which is the value of the origin (docs/spec/projects.md#tab-origin).
 * path names the operation that creates the tab (add space, new tab, split), for the refusal of a missing origin.
 */
export function recordOrigin(tabId, fromTabId, path) {
  if (typeof path !== "string" || path === "") throw new TypeError("recordOrigin requires the path that creates the tab");
  // default: no source tab, or no recorded directory, means a null origin directory.
  origins.set(tabId, Object.freeze({ directory: (fromTabId && directories.get(fromTabId)) ?? null }));
  createdBy.set(tabId, path);
  everHeld.add(tabId);
}

/** The history of a tab id for the refusal of a missing origin: its creation path and whether this session recorded its origin. */
export function originHistory(tabId) {
  // default: a tab whose origin no stored layout dropped is named so, which is the fact the record reports.
  const dropped = forgottenBy.get(tabId) ?? "no stored layout";
  // default: a tab whose creation this session did not record is named so, which is the fact the record reports.
  return `created by ${createdBy.get(tabId) ?? "no recorded path"}, held by this session: ${everHeld.has(tabId) ? "yes" : "no"}, ` +
    `origin dropped by ${dropped}`;
}

/** The reading rule of a non-view tab without an origin member: the released format-1 origin {directory: null} (docs/spec/projects.md#tab-origin). */
export const releasedNonViewOrigin = () => Object.freeze({ directory: null });

/**
 * Restores the origin of one tab of a stored layout, read by presence: an absent member is missing for a view tab and the released
 * reading for a non-view tab. The validator (originFault) runs once here, at the layout read. A refusal is kept as data on the tab and
 * returned as its text; this function never throws (docs/spec/projects.md#tab-origin).
 */
export function restoreOrigin(tab, viewTab) {
  // A tab read from a stored layout has no creation path of this session; the stored layout is its record.
  if (!createdBy.has(tab.id)) createdBy.set(tab.id, "stored layout");
  everHeld.add(tab.id);
  // A tab that a stored layout holds again has not left it.
  leftWhileMounted.delete(tab.id);
  // A tab whose origin this session recorded keeps it: a layout that is applied before it is stored has no origin member for it.
  if (origins.has(tab.id)) return null;
  const present = "origin" in tab;
  if (!viewTab) {
    loaded.set(tab.id, { origin: present ? tab.origin : releasedNonViewOrigin() });
    return null;
  }
  loaded.set(tab.id, present ? { origin: tab.origin } : null);
  const fault = originFault(tab.id, present ? tab.origin : undefined);
  if (fault === null) {
    // A valid origin replaces an earlier refusal of the same tab.
    refusals.delete(tab.id);
    return null;
  }
  refusals.set(tab.id, fault);
  return fault;
}

/** The refusal text of a restored view tab, or null when it has none. */
// default: a tab without a recorded refusal has no refusal text.
export const viewRefusal = (tabId) => refusals.get(tabId) ?? null;

/**
 * The origin that a view of tabId starts with: its recorded origin, or the origin loaded from the layout. A tab with neither throws:
 * no value is filled in (AGENTS.md, reject invalid values at the boundary).
 */
export function tabOrigin(tabId) {
  if (origins.has(tabId)) return origins.get(tabId);
  const kept = loaded.get(tabId);
  if (!kept) throw new TypeError(`tab ${tabId} has no origin`);
  return kept.origin;
}

/**
 * The origin member that the layout stores for tabId: {origin} to write, or null when a loaded view tab has no member. Throws for a tab
 * with neither a recorded origin nor a loaded one.
 */
export function storedOriginMember(tabId) {
  if (origins.has(tabId)) return { origin: origins.get(tabId) };
  if (!loaded.has(tabId)) throw new TypeError(`tab ${tabId} has no origin to store`);
  return loaded.get(tabId);
}

// The writing paths of a layout write: the operation that stores the layout (docs/spec/projects.md#tab-origin).
const WRITING_PATHS = ["add space", "saved layout", "recreate", "library replacement"];

/**
 * The error records of a layout write: one record for each view tab of the state that the write stores without an origin member. The
 * write names its writing path; a read names none (null) and records nothing. The stored tab keeps no member, so the next layout read
 * refuses it (docs/spec/projects.md#tab-origin).
 */
export function missingOriginRecords(state, path) {
  if (path === null) return [];
  if (!WRITING_PATHS.includes(path)) throw new TypeError(`unknown layout writing path: ${String(path)}`);
  const records = [];
  for (const card of stateCards(state)) {
    // default: a card without tabs has no view tab to record.
    for (const tab of card.data?.tabs ?? []) {
      if (storedOriginMember(tab.id) === null) records.push(`${path} stores tab ${tab.id} of plugin ${tab.plugin} without an origin member`);
    }
  }
  return records;
}

/**
 * The stored form of a layout state: each content-card tab carries its origin member. The state is the displayed layout only, so the
 * origins of the tabs of the other spaces are not read or changed here (docs/spec/projects.md#tab-origin).
 */
export function storedLayoutState(state) {
  return mapStateCards(state, (card) => {
    if (!Array.isArray(card.data?.tabs)) return card;
    const tabs = card.data.tabs.map((tab) => {
      // The member of the layout is replaced by the origin that the tab holds, so a stored value is never read twice.
      const { origin: _stored, ...rest } = tab;
      const member = storedOriginMember(tab.id);
      // A tab without a role stores null as its member role (docs/spec/agent-roles.md#tab-role-state); a stored record is kept.
const withRole = { ...rest, role: rest.role ?? null }; // default: a tab record read without its member role holds null.
      return member === null ? withRole : { ...withRole, origin: member.origin };
    });
    return { ...card, data: { ...card.data, tabs } };
  });
}

/**
 * Drops the origin of each tab that the previous stored layout of a space held and its next stored layout does not hold. Only the stored
 * layout of the tab's own space ends its origin, so a tab of another space keeps it (docs/spec/projects.md#tab-origin). A closed tab keeps
 * no origin, and an id is not reused, so dropping its record loses no value. `operation` names the operation that stored the next layout,
 * which the refusal of a missing origin names.
 */
export function forgetTabsLeft(previousCards, nextCards, operation) {
  if (typeof operation !== "string" || operation === "") throw new TypeError("forgetTabsLeft requires the operation that stores the layout");
  // default: a card without tabs keeps no tab.
  const kept = new Set(nextCards.flatMap((card) => (card.data?.tabs ?? []).map((tab) => tab.id)));
  // A tab that the next stored layout holds has not left, so an earlier departure of it is cancelled.
  for (const tabId of kept) leftWhileMounted.delete(tabId);
  for (const card of previousCards) {
    // default: a card without tabs holds no tab that could leave.
    for (const tab of card.data?.tabs ?? []) {
      if (kept.has(tab.id)) continue;
      // The record names the tabs that the stored layout held, so a drop by a layout of another state is visible in it.
      const held = `${operation}, whose stored layout held ${kept.size === 0 ? "no tab" : `the tabs ${[...kept].join(", ")}`}`;
      // A surface that is still mounted keeps the origin it started with until it is disposed (docs/spec/projects.md#tab-origin).
      if (mountedTab(tab.id)) {
        leftWhileMounted.set(tab.id, held);
        continue;
      }
      dropOrigin(tab.id, held);
    }
  }
}

/** Removes the origin of a tab that left its stored layout, and records the operation that dropped it for the refusal of a missing origin. */
function dropOrigin(tabId, operation) {
  origins.delete(tabId);
  loaded.delete(tabId);
  refusals.delete(tabId);
  forgottenBy.set(tabId, operation);
}

/** Records whether the surface of tabId reports work in progress (docs/spec/plugins.md#memory-saver). */
export function reportKeep(tabId, reason, on) {
  if (reason !== "busy") throw new TypeError(`unknown keep reason: ${String(reason)}`);
  if (typeof on !== "boolean") throw new TypeError("keep busy must be true or false");
  if (busy.has(tabId) === on) return;
  if (on) busy.add(tabId);
  else busy.delete(tabId);
  // The memory saver re-arms its scheduler on a change of a protection (docs/spec/plugins.md#memory-saver).
  notify();
}

/** The keep protections that the reports of tabId give: keep:modified and keep:busy. */
export const tabKeeps = (tabId) => [...(modified.has(tabId) ? ["keep:modified"] : []), ...(busy.has(tabId) ? ["keep:busy"] : [])];

/** Records the state of tabId that the memory saver reports: loaded, unloaded or restoring. */
export function reportTabState(tabId, state) {
  if (!MEMORY_STATES.has(state)) throw new TypeError(`unknown tab state: ${String(state)}`);
  // default: a tab that the memory saver did not report is loaded.
  if ((memoryStates.get(tabId) ?? "loaded") === state) return;
  if (state === "loaded") memoryStates.delete(tabId);
  else memoryStates.set(tabId, state);
  notify();
}

// default: a tab that the memory saver did not report is loaded.
export const tabMemoryState = (tabId) => memoryStates.get(tabId) ?? "loaded";

/**
 * The data of the button of tab {id, title}: the name, with the modified mark and the reported or cached label, and the
 * memory saver state of `data-tab-state` (docs/spec/exposure.md#tab-memory).
 */
// The strip draws the mark of the plugin before the stored name of a tab that reported no title; an unknown plugin has the mark "?"
// (docs/spec/example-model.md#card-tabs).
export function tabButtonData(tab) {
  const marked = { ...tab, title: `${hasPlugin(tab.plugin) ? plugin(tab.plugin).mark : "?"} ${tab.title}` };
  return { name: tabName(marked, labels.get(tab.id), modified.has(tab.id)), tabState: tabMemoryState(tab.id) };
}

/**
 * Releasing a surface in the unload mode keeps the reports of its tab and clears the error, whose display ended with the
 * instance, and the busy report, which ends at dispose (docs/spec/plugins.md#memory-saver).
 */
export function unloadTab(tabId) {
  busy.delete(tabId);
  if (errors.delete(tabId)) notify();
}

/** Releasing a surface also clears the notice of its tab. */
export function forgetTab(tabId) {
  busy.delete(tabId);
  memoryStates.delete(tabId);
  directories.delete(tabId);
  const noticed = systemNotices.delete(tabId);
  noticeStore.withdrawTab(tabId);
  const footed = footers.delete(tabId);
  const unsaved = modified.delete(tabId);
  const failed = errors.delete(tabId);
  if (labels.delete(tabId) || noticed || footed || unsaved || failed) notify();
}

export function onTabReports(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribes to the changes of the shown toasts; the entries that the center holds notify onTabReports only (docs/spec/notifications.md#toasts). */
export function onToastChange(listener) {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}
