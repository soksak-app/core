// Checks a stored space layout. Opening a layout and the library preview use the same check, so the preview
// filters out a layout that cannot be opened and does not draw it (docs/spec/projects.md).
import { Soksak, checkState } from "soksak";
import { pluginUnits } from "./environment.js";
import { readGroupTree } from "./group-tree.js";
import { stateCards } from "./layout-tree.js";
import { reportError, restoreOrigin } from "./tab-reports.js";
import { windowSidebar } from "./window-sidebars.js";

// The members of a stored space layout (docs/spec/groups.md#storage), with groups, the earlier group list that readGroupTree refuses.
const LAYOUT_MEMBERS = ["state", "leader", "lastCard", "focusedId", "named", "sidebars", "windowSidebars", "groups"];

// A plugin whose declared surface is a view (docs/spec/native-surfaces.md#view-surfaces). A plugin that is not loaded is not a view.
const viewPlugin = (id) => pluginUnits().find(unit => unit.id === id)?.composition === "view";

const FINGERPRINT = /^[0-9a-f]{16}$/;
const ROLE_RECORD_MEMBERS = ["id", "generation", "fingerprint", "confirmedFingerprint"];

/**
 * Checks the member role of a stored tab: null, or the whole record of its agent role with exactly the four members of
 * docs/spec/agent-roles.md#tab-role-state. A tab without the member, or with another value, is refused with its id.
 */
function checkTabRole(tab) {
  if (!Object.hasOwn(tab, "role")) throw new Error(`tab ${tab.id} member role is missing`);
  if (tab.role === null) return;
  const role = tab.role;
  const valid = role !== null && typeof role === "object" && !Array.isArray(role)
    && Object.keys(role).sort().join() === [...ROLE_RECORD_MEMBERS].sort().join()
    && typeof role.id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(role.id)
    && Number.isInteger(role.generation) && role.generation >= 1
    && typeof role.fingerprint === "string" && FINGERPRINT.test(role.fingerprint)
    && (role.confirmedFingerprint === null || (typeof role.confirmedFingerprint === "string" && FINGERPRINT.test(role.confirmedFingerprint)));
  if (!valid) throw new Error(`tab ${tab.id} member role is invalid`);
}

/**
 * Restores the origin of each tab of a stored layout, before any tab is created (docs/spec/projects.md#tab-origin). A refused view tab shows
 * its text on the tab. The refusals are returned as {tabId, text} so the caller logs them; a refusal never throws.
 */
export function recordStoredOrigins(kept, isViewTab = viewPlugin) {
  const refused = [];
  for (const card of stateCards(kept.state)) {
    // default: a format-1 card with no tab list has no tabs to restore.
    for (const tab of card.data?.tabs ?? []) {
      const text = restoreOrigin(tab, isViewTab(tab.plugin));
      if (text === null) continue;
      reportError(tab.id, text);
      refused.push({ tabId: tab.id, text });
    }
  }
  return refused;
}

/**
 * Throws an exception with the reason if the stored layout kept cannot be opened in the current environment. After the cards and the
 * sidebar choices, the grid and the group tree are read with the refusals of docs/spec/groups.md#storage on a grid of their own, so the
 * check changes no shown grid.
 */
export function checkStoredLayout(kept) {
  if (Object.hasOwn(kept, "sidebars") && (!kept.sidebars || typeof kept.sidebars !== "object" || Array.isArray(kept.sidebars)))
    throw new Error("invalid stored sidebar choices");
  if (Object.hasOwn(kept, "railWidth") || Object.hasOwn(kept, "edgeWidth")) throw new Error("obsolete window sidebar state");
  // A member that the storage does not define is refused, so a member of an earlier form is not dropped at the next write;
  // groups is refused by readGroupTree with the text of the earlier group list (docs/spec/groups.md#storage).
  const unknown = Object.keys(kept).filter((key) => !LAYOUT_MEMBERS.includes(key)).sort();
  if (unknown.length) throw new Error(`layout stores ${unknown.join(", ")}, which a space layout does not hold`);
  // The tree of the layout is read first, so a state in an earlier form is refused with what it holds before its cards are read.
  checkState(kept.state);
  const units = pluginUnits();
  for (const card of stateCards(kept.state)) {
    if (card.id.startsWith("window:")) throw new Error(`obsolete stored window sidebar ${card.id}`);
    if (card.id.startsWith("rail-")) throw new Error(`obsolete stored rail card ${card.id}`);
    const descriptor = windowSidebar(card.id);
    if (descriptor) {
      if (card.data !== null && card.data !== undefined) throw new Error(`invalid stored window sidebar data ${card.id}`);
    } else {
      // An earlier form of card sidebars is refused; the stored layout is not converted (AGENTS.md).
      for (const key of ["panels", "sidebar"]) {
        if (card.data && Object.hasOwn(card.data, key)) throw new Error(`card ${card.id} stores ${key}, an earlier form of sidebars`);
      }
      const tabs = card.data?.tabs;
      if (!Array.isArray(tabs)) throw new Error(`invalid stored content card ${card.id}`);
      // A tab of a plugin that is not loaded opens as a placeholder, and a loaded plugin must have a surface (docs/spec/plugins.md).
      for (const tab of tabs) {
        const unit = units.find(item => item.id === tab.plugin);
        if (unit && !unit.surface) throw new Error(`stored tab plugin ${tab.plugin} has no surface`);
        checkTabRole(tab);
      }
      // An empty card stores the active id null, and a card with tabs the id of one of them (docs/spec/projects.md#persistence).
      const active = tabs.length === 0 ? card.data.activeId === null : tabs.some(tab => tab.id === card.data.activeId);
      if (!active) throw new Error(`invalid stored active tab ${card.id}`);
    }
  }
  const content = new Set(stateCards(kept.state).filter((card) => card.data).map((card) => card.id));
  // default: sidebars is an optional field of a stored layout.
  for (const id of Object.keys(kept.sidebars ?? {})) {
    if (id.startsWith("rail-") || id.startsWith("window:")) throw new Error(`obsolete stored sidebar ${id}`);
    if (content.has(id)) throw new Error(`sidebar choice ${id} names card ${id}, an earlier form of ${id}:left`);
  }
  readGroupTree(kept, { gap: 0, minSize: 0, head: 0 }, new Soksak());
}
