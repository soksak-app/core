// Manages the content override and the size of the fixed window sidebars of the four edges (docs/spec/external-sidebars.md).
import { WINDOW_EDGES } from "@soksak/plugin-api";

export { WINDOW_EDGES };

export function windowSidebar(id) {
  return WINDOW_EDGES.includes(id) ? { side: id, plugin: null } : null;
}

/** The axis of the sidebar of an edge: x for left and right, y for top and bottom. */
export function windowAxis(edge) {
  if (!windowSidebar(edge)) throw new Error(`unknown window sidebar ${edge}`);
  return edge === "left" || edge === "right" ? "x" : "y";
}

/** The member of the saved size of the sidebar of an edge: width for left and right, height for top and bottom. */
export function sizeKey(edge) {
  return windowAxis(edge) === "x" ? "width" : "height";
}

export function windowSidebarCards(units, links, focused = null) {
  // When the focus is on a tab of a plugin that is not loaded, the link of that plugin chooses no content and the general choice is shown
  // (docs/spec/plugins.md).
  const focusedPlugin = focused !== null && units.some(unit => unit.id === focused) ? focused : null;
  const out = [];
  for (const side of WINDOW_EDGES) {
    const choices = links.filter(link => link.place === side || link.place === `window-${side}`);
    if (!choices.length) continue;
    const override = focusedPlugin === null ? undefined : choices.find(link => link.place === `window-${side}` && link.plugin === focusedPlugin);
    const general = choices.find(link => link.place === side && link.plugin === null);
    // default: without an override of the focused plugin, the general choice is used (docs/spec/external-sidebars.md).
    const chosen = override ?? general;
    // default: without a choice, that fixed sidebar has no content set.
    out.push({ id: side, side, plugin: override ? focusedPlugin : null, set: chosen?.set ?? null });
  }
  return out;
}

export function restoreWindowSidebars(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("invalid window sidebar records");
  const out = {};
  for (const [id, record] of Object.entries(saved)) {
    if (!windowSidebar(id)) throw new Error(`unknown window sidebar ${id}`);
    const key = sizeKey(id);
    const other = key === "width" ? "height" : "width";
    const keys = record && typeof record === "object" && !Array.isArray(record) ? Object.keys(record) : null;
    // The record of the other axis is an earlier or a wrong form; it is refused, not converted (docs/spec/external-sidebars.md).
    if (keys?.length === 1 && keys[0] === other) throw new Error(`window sidebar ${id} saves ${key}, not ${other}`);
    if (!keys || keys.some(item => item !== key) || !Number.isFinite(record[key]) || record[key] <= 0) throw new Error(`invalid window sidebar ${id}`);
    out[id] = { [key]: record[key] };
  }
  return out;
}

export function reconcileWindowSidebars(records, descriptors, initialWidth) {
  if (!Number.isFinite(initialWidth) || initialWidth <= 0) throw new Error("invalid initial window sidebar width");
  for (const descriptor of descriptors) {
    if (!windowSidebar(descriptor.id)) throw new Error(`unknown window sidebar ${descriptor.id}`);
    // default: a fixed sidebar without a size record starts with the initial size on its axis.
    records[descriptor.id] ??= { [sizeKey(descriptor.id)]: initialWidth };
  }
}

/**
 * Returns the link that chooses the set that the fixed sidebar place shows. It is the window-* link if the override of the focused plugin applies,
 * otherwise the general link, and null if there is no set. An unknown place is an exception.
 */
export function standingLink(place, descriptors) {
  const descriptor = descriptors.find(item => item.id === place);
  if (!descriptor) throw new Error(`unknown window sidebar ${place}`);
  if (descriptor.set === null) return null;
  return descriptor.plugin === null ? { place: descriptor.side, plugin: null } : { place: `window-${descriptor.side}`, plugin: descriptor.plugin };
}

/** The fixed sidebars to bind with the focused card by the rail. Only sidebars to which a plugin override applied and that are in the plane are bound. */
export function railSidebars(descriptors, present) {
  return descriptors.filter(item => item.plugin !== null && present(item.id)).map(item => item.id);
}

/** Copies the size drawn on its axis of the fixed sidebar cards of the plane into the records records: the width of a left or right card, the height of a top or bottom card. */
export function keepWindowSidebarWidths(cards, records) {
  for (const card of cards.filter(card => windowSidebar(card.id))) {
    const key = sizeKey(card.id);
    if (card[key] !== undefined) records[card.id] = { [key]: card[key] };
  }
}

/** The edges that hold a window sidebar, in the order: an edge that has a choice (sides) and whose switch is on. */
export function dockedEdges(order, sides, shown) {
  return order.filter(edge => sides.includes(edge) && shown(edge));
}

/**
 * The place that the order gives the sidebar of each docked edge, in grid lines: the line of its edge on its axis, and its range on the
 * other axis from the border or the inner line of the sidebar of an earlier edge of that axis to the opposite border or the inner line of
 * such a sidebar (docs/spec/external-sidebars.md#fixed-placement-and-persistence). An edge whose earlier cross sidebar is not on the
 * plane takes the border. Returns a map from edge to {axis, edge, line, from, to}.
 */
export function dockedPlaces(grid, docked) {
  const last = { x: grid.lines("x").length - 1, y: grid.lines("y").length - 1 };
  const places = new Map();
  docked.forEach((edge, index) => {
    const axis = windowAxis(edge);
    const cross = axis === "x" ? "y" : "x";
    const earlier = docked.slice(0, index);
    const low = cross === "y" ? "top" : "left";
    const high = cross === "y" ? "bottom" : "right";
    const lowCard = earlier.includes(low) ? grid.card(low) : undefined;
    const highCard = earlier.includes(high) ? grid.card(high) : undefined;
    const end = cross === "y" ? ["r0", "r1"] : ["c0", "c1"];
    places.set(edge, {
      axis,
      line: edge === "left" || edge === "top" ? 0 : last[axis],
      from: lowCard ? lowCard[end[1]] : 0,
      to: highCard ? highCard[end[0]] : last[cross],
    });
  });
  return places;
}

/** Whether the window sidebars of grid stand where the order places the docked edges, and no other window sidebar is on the plane. */
export function windowSidebarsDocked(grid, docked) {
  const present = grid.cards.filter(card => windowSidebar(card.id)).map(card => card.id);
  if (present.length !== docked.length || docked.some(edge => !present.includes(edge))) return false;
  const places = dockedPlaces(grid, docked);
  return docked.every(edge => {
    const card = grid.card(edge);
    const place = places.get(edge);
    const [own0, own1, cross0, cross1] = place.axis === "x" ? ["c0", "c1", "r0", "r1"] : ["r0", "r1", "c0", "c1"];
    const atEdge = edge === "left" || edge === "top" ? card[own0] === place.line : card[own1] === place.line;
    return card.fixed && atEdge && card[cross0] === place.from && card[cross1] === place.to;
  });
}

/**
 * Docks the window sidebars in the order (docs/spec/external-sidebars.md#fixed-placement-and-persistence). order lists the four edges,
 * sides are the edges that have a choice, and shown(edge) is the switch of an edge. When the window sidebars of the plane already stand
 * where the order places them, nothing moves, so a change of focus or of the override does not move a sidebar. Otherwise every window
 * sidebar is closed, the lines that no card references are removed, and the docked edges are inserted in the reverse of the order at the
 * border line of their edge with their saved size and set fixed, so the first edge reaches across the plane. A sidebar whose only filler is
 * a fixed card while its slots hold another card cannot leave yet (R7 of packages/soksak/docs/layout.md); it leaves after the others.
 * Returns whether the plane changed.
 */
export function arrangeWindowSidebars(grid, order, sides, records, initialWidth, shown) {
  const docked = dockedEdges(order, sides, shown);
  reconcileWindowSidebars(records, [...docked, ...grid.cards.filter(card => windowSidebar(card.id)).map(card => card.id)].map(id => ({ id })), initialWidth);
  keepWindowSidebarWidths(grid.cards, records);
  if (windowSidebarsDocked(grid, docked)) return false;
  // A sidebar that cannot leave yet waits until another window sidebar has left.
  for (let left = grid.cards.filter(card => windowSidebar(card.id)); left.length; left = grid.cards.filter(card => windowSidebar(card.id))) {
    const closed = left.find(card => {
      grid.setFixed(card.id, false);
      if (grid.close(card.id)) return true;
      grid.setFixed(card.id, true);
      return false;
    });
    if (!closed) throw new Error(`cannot remove window sidebars ${left.map(card => card.id).join(", ")}`);
    // After a card is closed, nothing references the lines that card referenced; a sidebar that opens again adds new lines, so they
    // would accumulate in one slot.
    grid.tidy();
  }
  for (const edge of [...docked].reverse()) {
    const axis = windowAxis(edge);
    const line = edge === "left" || edge === "top" ? 0 : grid.lines(axis).length - 1;
    if (!grid.canInsertAt(axis, line)) throw new Error(`cannot place window sidebar ${edge}`);
    grid.insertAt(axis, line, { id: edge, data: null, size: records[edge][sizeKey(edge)] });
    grid.setFixed(edge, true);
  }
  return true;
}
