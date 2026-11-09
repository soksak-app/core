// The section surfaces of the shown space and of the stored layouts (docs/spec/plugins.md#sections). The sidebars of the shown space
// draw the first, and the project store reads the second to keep their sidecar sessions with the tabs of the layouts. This module
// imports nothing of the workbench, because the sidebar sections import the surface modules, which import the project store; its
// only import is the side list of the plugin API, which imports nothing of the workbench.
import { WINDOW_SIDES } from "@soksak/plugin-api";

const shown = new Set();

/**
 * The surface id of a section in a sidebar of a space (docs/spec/plugins.md#sections). The sidebar ids repeat in every window
 * and the card ids in every space, so the space makes the id name one surface of the host.
 */
export const sectionSurfaceId = (space, sidebar, sectionId) => `${space}/${sidebar}/${sectionId}`;

/** Records that a drawn sidebar holds the section surface. */
export const showSectionSurface = (surfaceId) => { shown.add(surfaceId); };

/** Records that no drawn sidebar holds the section surface. */
export const hideSectionSurface = (surfaceId) => { shown.delete(surfaceId); };

/** Whether a drawn sidebar holds the section surface. */
export const sectionSurfaceShown = (surfaceId) => shown.has(surfaceId);

/** The section surfaces that the drawn sidebars hold, in the order they were drawn. */
export const shownSectionSurfaces = () => [...shown];

/**
 * The section surfaces that a space holds, from its stored cards and the sets and links of its project. A session stays
 * recoverable while a layout holds its surface (docs/spec/persistent-services.md), so the list does not depend on what a window
 * draws: a window sidebar holds every set that a link gives it, and the side of a card holds the set that it chose or the set linked
 * to the plugin of each of its tabs. A set that is gone and a side that is off hold nothing.
 */
export function spaceSectionSurfaces(space, cards, sets, links) {
  const surfaces = [];
  const hold = (sidebar, chosen) => {
    for (const id of new Set(chosen)) {
      const set = sets.find((item) => item.id === id);
      if (set) surfaces.push(...set.sections.map((section) => sectionSurfaceId(space, sidebar, section)));
    }
  };
  for (const side of WINDOW_SIDES) {
    hold(side, links.filter((link) => link.place === side || link.place === `window-${side}`).map((link) => link.set));
  }
  for (const card of cards) {
    if (!card.data) continue; // A seat card has no sides.
    for (const side of ["top", "bottom", "left", "right"]) {
      const own = card.data.sidebars?.[side]?.set;
      const plugins = card.data.tabs.map((tab) => tab.plugin);
      hold(`${card.id}:${side}`, own !== undefined ? [own]
        : links.filter((link) => link.place === `card-${side}` && plugins.includes(link.plugin)).map((link) => link.set));
    }
  }
  return surfaces;
}

/**
 * The rule that keeps a stored tab state or tab session at a load (docs/spec/projects.md): the entry of a tab of a layout, and
 * the entry of a section surface `<space>/<sidebar>/<section>` whose space is a space of a layout and whose sidebar is a window
 * sidebar (`left`, `right`, `top`, `bottom`) or a sidebar `<card>:<side>` of a card of the layout of that space. spaceCards maps each space id to
 * the card ids of its layout. The sets of the sidebars depend on settings that a load does not resolve, so the rule reads only the
 * space and the sidebar of the id.
 */
export function storedSurfaceKept(tabIds, spaceCards) {
  return (id) => {
    if (tabIds.has(id)) return true;
    const [space, sidebar] = id.split("/");
    const cards = spaceCards.get(space);
    if (!cards || sidebar === undefined) return false;
    if (WINDOW_SIDES.includes(sidebar)) return true;
    const colon = sidebar.lastIndexOf(":");
    return colon > 0 && cards.has(sidebar.slice(0, colon));
  };
}
