// The edge buttons of the window sides (docs/spec/external-sidebars.md#sidebar-head-and-edge). A side that is hidden and has a choice shows
// its + <side> button at its edge while the pointer is over the edge. The button runs the side switch with the value true.
import { bind } from "./commands.js";

const LABELS = { left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" };

/**
 * Draws one edge per side into container. appliedPatch(side, value) gives the scope of the applied value of side, links() gives the
 * settings links and value(side) the applied value of side. draw(hidden) shows the edges that apply: a hidden side with a choice, and
 * no edge while hidden is true (the project home or the settings tab in front).
 */
export function createSidebarEdges(container, { appliedPatch, links, value }) {
  const edges = Object.keys(LABELS).map((side) => {
    const edge = document.createElement("div");
    edge.className = "sidebar-edge";
    edge.dataset.side = side;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-edge__button";
    button.dataset.expose = "core.sidebar.edge";
    button.textContent = `+ ${LABELS[side]}`;
    bind(button, "core.settings.change", () => ({ key: side, value: true, scope: appliedPatch(side, true).scope }));
    edge.append(button);
    return edge;
  });
  container.replaceChildren(...edges);
  return {
    draw(hidden) {
      for (const edge of edges) {
        const side = edge.dataset.side;
        const choice = links().some((link) => link.place === side || link.place === `window-${side}`);
        edge.hidden = hidden || value(side) || !choice;
      }
    },
  };
}
