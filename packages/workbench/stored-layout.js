// Checks a stored space layout. Opening a layout and the library preview use the same check, so the preview
// filters out a layout that cannot be opened and does not draw it (docs/spec/projects.md).
import { pluginUnits } from "./environment.js";
import { reportError, restoreOrigin } from "./tab-reports.js";
import { windowSidebar } from "./window-sidebars.js";

// A plugin whose declared surface is a view (docs/spec/native-surfaces.md#view-surfaces). A plugin that is not loaded is not a view.
const viewPlugin = (id) => pluginUnits().find(unit => unit.id === id)?.surface?.composition?.kind === "view";

/**
 * Restores the origin of each tab of a stored layout, before any tab is created (docs/spec/projects.md#tab-origin). A refused view tab shows
 * its text on the tab. The refusals are returned as {tabId, text} so the caller logs them; a refusal never throws.
 */
export function recordStoredOrigins(kept, isViewTab = viewPlugin) {
  const refused = [];
  for (const card of kept.state.cards) {
    for (const tab of card.data?.tabs ?? []) {
      const text = restoreOrigin(tab, isViewTab(tab.plugin));
      if (text === null) continue;
      reportError(tab.id, text);
      refused.push({ tabId: tab.id, text });
    }
  }
  return refused;
}

/** Throws an exception with the reason if the stored layout kept cannot be opened in the current environment. */
export function checkStoredLayout(kept) {
  if (Object.hasOwn(kept, "sidebars") && (!kept.sidebars || typeof kept.sidebars !== "object" || Array.isArray(kept.sidebars)))
    throw new Error("invalid stored sidebar choices");
  if (Object.hasOwn(kept, "railWidth") || Object.hasOwn(kept, "edgeWidth")) throw new Error("obsolete window sidebar state");
  const units = pluginUnits();
  for (const card of kept.state.cards) {
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
      if (!Array.isArray(tabs) || !tabs.length) throw new Error(`invalid stored content card ${card.id}`);
      // A tab of a plugin that is not loaded opens as a placeholder, and a loaded plugin must have a surface (docs/spec/plugins.md).
      for (const tab of tabs) {
        const unit = units.find(item => item.id === tab.plugin);
        if (unit && !unit.surface) throw new Error(`stored tab plugin ${tab.plugin} has no surface`);
      }
      if (!tabs.some(tab => tab.id === card.data.activeId)) throw new Error(`invalid stored active tab ${card.id}`);
    }
  }
  const content = new Set(kept.state.cards.filter((card) => card.data).map((card) => card.id));
  // default: sidebars is an optional field of a stored layout.
  for (const id of Object.keys(kept.sidebars ?? {})) {
    if (id.startsWith("rail-") || id.startsWith("window:")) throw new Error(`obsolete stored sidebar ${id}`);
    if (content.has(id)) throw new Error(`sidebar choice ${id} names card ${id}, an earlier form of ${id}:left`);
  }
}
