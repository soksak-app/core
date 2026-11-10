// Manages the content override and the size of the fixed window sidebars of the four sides (docs/spec/external-sidebars.md).
import { WINDOW_SIDES } from "@soksak/plugin-api";

export { WINDOW_SIDES };

export function windowSidebar(id) {
  return WINDOW_SIDES.includes(id) ? { side: id, plugin: null } : null;
}

/** The axis of the sidebar of a side: x for left and right, y for top and bottom. */
export function windowAxis(side) {
  if (!windowSidebar(side)) throw new Error(`unknown window sidebar ${side}`);
  return side === "left" || side === "right" ? "x" : "y";
}

/** The names of the sides in the status line, the fold control and the chrome switch of a window sidebar. */
export const SIDE_NAMES = Object.freeze({ left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" });

/** The fold chevron of the status line of the sidebar of each side, pointing toward the side. */
export const FOLD_ICONS = Object.freeze({ left: "chevron-left", right: "chevron-right", top: "chevron-up", bottom: "chevron-down" });

/**
 * The switches of the window sidebars in the window chrome, one per side in the fixed order left, right, top, bottom: the side, the icon,
 * the tooltip and the exposure element of each (docs/spec/external-sidebars.md#window-controls).
 */
export function chromeSwitches() {
  return [
    { side: "left", icon: "panel-left", title: "왼쪽 사이드바 보이기", expose: "core.chrome.left" },
    { side: "right", icon: "panel-right", title: "오른쪽 사이드바 보이기", expose: "core.chrome.right" },
    { side: "top", icon: "panel-top", title: "위 사이드바 보이기", expose: "core.chrome.top" },
    { side: "bottom", icon: "panel-bottom", title: "아래 사이드바 보이기", expose: "core.chrome.bottom" },
  ];
}

/** The orientation of the sections of the sidebar of a side: vertical at left and right, horizontal at top and bottom. */
export function windowOrientation(side) {
  return windowAxis(side) === "x" ? "vertical" : "horizontal";
}

/** The member of the saved size of the sidebar of a side: width for left and right, height for top and bottom. */
export function sizeKey(side) {
  return windowAxis(side) === "x" ? "width" : "height";
}

export function windowSidebarCards(units, links, focused = null) {
  // When the focus is on a tab of a plugin that is not loaded, the link of that plugin chooses no content and the general choice is shown
  // (docs/spec/plugins.md).
  const focusedPlugin = focused !== null && units.some(unit => unit.id === focused) ? focused : null;
  const out = [];
  for (const side of WINDOW_SIDES) {
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

/** The plane state of the last dock of each grid and the arrangement it could not place: a refused dock writes it, and a settle on the same plane state does not attempt the refused arrangement again. */
const dockedPlanes = new WeakMap();

/** One string that changes when the plane changes: the count of the cards, the lines of both axes with their places, and the size of the plane. */
function planeToken(grid) {
  return `${grid.cards.length}|${grid.lines("x")}|${grid.lines("y")}|${grid.width}x${grid.height}`;
}

/**
 * The largest size that an insertion at the boundary holds with every card above the layout's minimum, found by asking the
 * insertion itself: a refused insertion restores the plane, and an accepted one is undone by putting the recorded state back.
 * Returns 0 when no size holds.
 */
function fittingSize(grid, axis, line, wanted) {
  const restore = grid.toJSON();
  let low = 0, high = wanted;
  while (high - low > 1) {
    const mid = (low + high) / 2;
    if (grid.insertAt(axis, line, { size: mid }) !== null) {
      low = mid;
      grid.replace(restore);
    } else {
      high = mid;
    }
  }
  return low;
}

/** The sides that hold a window sidebar, in the order: a side that has a choice (sides) and whose switch is on. */
export function arrangedSides(order, sides, shown) {
  return order.filter(side => sides.includes(side) && shown(side));
}

/**
 * The place that the order gives the sidebar of each arranged side, in grid lines: the line of its side on its axis, and its range on the
 * other axis from the border or the inner line of the sidebar of an earlier side of that axis to the opposite border or the inner line of
 * such a sidebar (docs/spec/external-sidebars.md#fixed-placement-and-persistence). A side whose earlier cross sidebar is not on the
 * plane takes the border. Returns a map from side to {axis, side, line, from, to}.
 */
export function arrangedPlaces(grid, arranged) {
  const last = { x: grid.lines("x").length - 1, y: grid.lines("y").length - 1 };
  const places = new Map();
  arranged.forEach((side, index) => {
    const axis = windowAxis(side);
    const cross = axis === "x" ? "y" : "x";
    const earlier = arranged.slice(0, index);
    const low = cross === "y" ? "top" : "left";
    const high = cross === "y" ? "bottom" : "right";
    const lowCard = earlier.includes(low) ? grid.card(low) : undefined;
    const highCard = earlier.includes(high) ? grid.card(high) : undefined;
    const end = cross === "y" ? ["r0", "r1"] : ["c0", "c1"];
    places.set(side, {
      axis,
      line: side === "left" || side === "top" ? 0 : last[axis],
      from: lowCard ? lowCard[end[1]] : 0,
      to: highCard ? highCard[end[0]] : last[cross],
    });
  });
  return places;
}

/** Whether the window sidebars of grid stand where the order places the arranged sides, and no other window sidebar is on the plane. */
export function windowSidebarsArranged(grid, arranged) {
  const present = grid.cards.filter(card => windowSidebar(card.id)).map(card => card.id);
  if (present.length !== arranged.length || arranged.some(side => !present.includes(side))) return false;
  const places = arrangedPlaces(grid, arranged);
  return arranged.every(side => {
    const card = grid.card(side);
    const place = places.get(side);
    const [own0, own1, cross0, cross1] = place.axis === "x" ? ["c0", "c1", "r0", "r1"] : ["r0", "r1", "c0", "c1"];
    const atSide = side === "left" || side === "top" ? card[own0] === place.line : card[own1] === place.line;
    return card.fixed && atSide && card[cross0] === place.from && card[cross1] === place.to;
  });
}

/**
 * Arranges the window sidebars in the order (docs/spec/external-sidebars.md#fixed-placement-and-persistence). order lists the four sides,
 * sides are the sides that have a choice, and shown(side) is the switch of a side. When the window sidebars of the plane already stand
 * where the order places them, nothing moves, so a change of focus or of the override does not move a sidebar. Otherwise every window
 * sidebar is closed, the lines that no card references are removed, and the arranged sides are inserted in the reverse of the order at the
 * border line of their side with their saved size and set fixed, so the first side reaches across the plane; the plane may not hold a
 * saved size with every card above the layout's minimum, so a sidebar stands at the largest size that an insertion holds, a side whose
 * sidebar no size holds is skipped with an error that names it, and a dock that the same plane state already refused is not attempted
 * again. A sidebar whose only filler is a fixed card while its slots hold another card cannot leave yet (R7 of
 * packages/soksak/docs/layout.md); it leaves after the others.
 * Returns whether the plane changed.
 */
export function arrangeWindowSidebars(grid, order, sides, records, initialWidth, shown) {
  const arranged = arrangedSides(order, sides, shown);
  reconcileWindowSidebars(records, [...arranged, ...grid.cards.filter(card => windowSidebar(card.id)).map(card => card.id)].map(id => ({ id })), initialWidth);
  const token = planeToken(grid);
  const seen = dockedPlanes.get(grid);
  keepWindowSidebarWidths(grid.cards, records);
  // A dock that this plane state already refused is not attempted again, so a plane that holds no size for a sidebar keeps answering.
  if (windowSidebarsArranged(grid, arranged) || (seen?.token === token && JSON.stringify(seen.refused) === JSON.stringify(arranged))) return false;
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
  const unplaceable = [];
  for (const side of [...arranged].reverse()) {
    const axis = windowAxis(side);
    const line = side === "left" || side === "top" ? 0 : grid.lines(axis).length - 1;
    if (!grid.canInsertAt(axis, line)) throw new Error(`cannot place window sidebar ${side}`);
    const saved = records[side][sizeKey(side)];
    // default: the plane holds the saved size, and a sidebar without room stands at the largest size that an insertion holds.
    let size = saved;
    if (grid.insertAt(axis, line, { id: side, data: null, size }) === null) {
      size = fittingSize(grid, axis, line, saved);
      if (size <= 0 || grid.insertAt(axis, line, { id: side, data: null, size }) === null) {
        // The plane holds no size for this sidebar, so the others still stand and the refusal names it.
        unplaceable.push(side);
        continue;
      }
    }
    grid.setFixed(side, true);
  }
  dockedPlanes.set(grid, { token: planeToken(grid), refused: unplaceable.length ? arranged : undefined });
  if (unplaceable.length) throw new Error(`cannot place window sidebars ${unplaceable.join(", ")}`);
  return true;
}
