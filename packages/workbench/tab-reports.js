import { isLocalAbsolutePath, originFault } from "@soksak/plugin-api";

// The tab title, the bottom text, and the working directory that a surface reported (docs/spec/plugins.md#tab-reports). They are not stored in the layout.
const labels = new Map();
const footers = new Map();
const directories = new Map();
const origins = new Map();
// The origin that the layout stored for each tab restored from it: {origin} with the stored value, or null when a view tab stored no member.
const loaded = new Map();
// The text of the refusal of a restored view tab whose origin fails the validator (docs/spec/native-surfaces.md#view-surfaces).
const refusals = new Map();
const notices = new Map();
const noticePolicies = new Map();
const modified = new Set();
const errors = new Map();
// The tabs whose surface reports work in progress through context.tab.keep("busy", true) (docs/spec/plugins.md#memory-saver).
const busy = new Set();
// The state of each tab that the memory saver does not hold loaded: unloaded or restoring (docs/spec/exposure.md#tab-memory).
const memoryStates = new Map();
const MEMORY_STATES = new Set(["loaded", "unloaded", "restoring"]);
// The plane tells whether a tab is visible (whether it is the active tab of the focused card).
let visibleTab = () => false;
const listeners = new Set();

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NOTICE_POLICIES = new Set(["tab", "system"]);

function notify() {
  for (const listener of listeners) listener();
}

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

/** Sets the function with which the plane decides whether a tab is visible. */
export function setVisibleTab(probe) {
  visibleTab = probe;
}

/** Puts a notice on a tab that is not visible. For a visible tab, the surface is already visible, so nothing is changed. */
export function reportNotice(tabId, text, policy = "tab") {
  if (typeof text !== "string" || text.length === 0 || text.length > 1024 || CONTROL.test(text)) {
    throw new TypeError("a tab notice must be 1 to 1024 characters without control characters");
  }
  if (!NOTICE_POLICIES.has(policy)) throw new TypeError(`unknown tab notice policy: ${String(policy)}`);
  if (visibleTab(tabId)) return;
  if (notices.get(tabId) === text && noticePolicies.get(tabId) === policy) return;
  notices.set(tabId, text);
  noticePolicies.set(tabId, policy);
  notify();
}

// default: a tab without a notice is null.
export const tabNotice = (tabId) => noticePolicies.get(tabId) === "system" ? null : (notices.get(tabId) ?? null);

/** The list of [tab id, text] of all tab notices. */
export const tabNotices = () => [...notices].filter(([tabId]) => noticePolicies.get(tabId) === "system");

/** Removes the notice of a tab that became visible. The plane calls it on every drawing. */
export function clearVisibleNotices() {
  let removed = false;
  for (const tabId of [...notices.keys()]) {
    if (visibleTab(tabId)) removed = notices.delete(tabId) || removed;
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
 */
export function recordOrigin(tabId, fromTabId) {
  // default: no source tab, or no recorded directory, means a null origin directory.
  origins.set(tabId, Object.freeze({ directory: (fromTabId && directories.get(fromTabId)) ?? null }));
}

/** The reading rule of a non-view tab without an origin member: the released format-1 origin {directory: null} (docs/spec/projects.md#tab-origin). */
export const releasedNonViewOrigin = () => Object.freeze({ directory: null });

/**
 * Restores the origin of one tab of a stored layout, read by presence: an absent member is missing for a view tab and the released
 * reading for a non-view tab. The validator (originFault) runs once here, at the layout read. A refusal is kept as data on the tab and
 * returned as its text; this function never throws (docs/spec/projects.md#tab-origin).
 */
export function restoreOrigin(tab, viewTab) {
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
  for (const card of state.cards) {
    // default: a card without tabs has no view tab to record.
    for (const tab of card.data?.tabs ?? []) {
      if (storedOriginMember(tab.id) === null) records.push(`${path} stores tab ${tab.id} of plugin ${tab.plugin} without an origin member`);
    }
  }
  return records;
}

// The tab ids of the last stored layout state. A tab that a stored layout held and that the next one does not hold has left the layout.
let storedIds = new Set();

/**
 * The stored form of a layout state: each content-card tab carries its origin member, and the records of tabs that left the stored
 * layout are dropped. The state is the displayed layout only, so a tab of another space, such as the first tab of a space that was added
 * and not displayed yet, has no record in it; that record is kept until a stored layout held the tab and no longer does. A closed tab
 * keeps no origin, and an id is not reused, so dropping its record loses no value.
 */
export function storedLayoutState(state) {
  const ids = new Set();
  const cards = state.cards.map((card) => {
    if (!Array.isArray(card.data?.tabs)) return card;
    const tabs = card.data.tabs.map((tab) => {
      ids.add(tab.id);
      // The member of the layout is replaced by the origin that the tab holds, so a stored value is never read twice.
      const { origin: _stored, ...rest } = tab;
      const member = storedOriginMember(tab.id);
      return member === null ? rest : { ...rest, origin: member.origin };
    });
    return { ...card, data: { ...card.data, tabs } };
  });
  for (const map of [origins, loaded, refusals]) {
    for (const id of [...map.keys()]) if (storedIds.has(id) && !ids.has(id)) map.delete(id);
  }
  storedIds = ids;
  return { ...state, cards };
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
export function tabButtonData(tab) {
  // default: a tab whose surface reported no title shows the title of its layout entry.
  const label = labels.get(tab.id) ?? tab.title;
  return { name: `${modified.has(tab.id) ? "● " : ""}${label}`, tabState: tabMemoryState(tab.id) };
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
  const noticed = notices.delete(tabId);
  noticePolicies.delete(tabId);
  const footed = footers.delete(tabId);
  const unsaved = modified.delete(tabId);
  const failed = errors.delete(tabId);
  if (labels.delete(tabId) || noticed || footed || unsaved || failed) notify();
}

export function onTabReports(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
