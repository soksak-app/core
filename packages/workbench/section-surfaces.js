// The section surfaces of the shown space (docs/spec/plugins.md#sections). The sidebars of the shown space draw them, and the
// project store reads them to keep their sidecar sessions and surfaces with the tabs of the layouts. This module has no imports,
// because the sidebar sections import the surface modules, which import the project store.

const shown = new Set();

/** Records that a drawn sidebar holds the section surface. */
export const showSectionSurface = (surfaceId) => { shown.add(surfaceId); };

/** Records that no drawn sidebar holds the section surface. */
export const hideSectionSurface = (surfaceId) => { shown.delete(surfaceId); };

/** The section surfaces that the drawn sidebars hold, in the order they were drawn. */
export const shownSectionSurfaces = () => [...shown];

/**
 * The rule that keeps a stored tab state or tab session at a load (docs/spec/projects.md): the entry of a tab of a layout, and
 * the entry of a section surface `<space>/<sidebar>/<section>` whose space is a space of a layout and whose sidebar is a window
 * sidebar (`left`, `right`) or a sidebar `<card>:<side>` of a card of the layout of that space. spaceCards maps each space id to
 * the card ids of its layout. The sets of the sidebars depend on settings that a load does not resolve, so the rule reads only the
 * space and the sidebar of the id.
 */
export function storedSurfaceKept(tabIds, spaceCards) {
  return (id) => {
    if (tabIds.has(id)) return true;
    const [space, sidebar] = id.split("/");
    const cards = spaceCards.get(space);
    if (!cards || sidebar === undefined) return false;
    if (sidebar === "left" || sidebar === "right") return true;
    const colon = sidebar.lastIndexOf(":");
    return colon > 0 && cards.has(sidebar.slice(0, colon));
  };
}
