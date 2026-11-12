// Verdicts of the card panel window check. test/card-panel-checks.test.mjs checks that the verdicts reject invalid input.
import assert from "node:assert/strict";

/** Fails when a panel remains after all panels are turned off. A remaining default panel fails as well. */
export function requireCleared(sidebars) {
  const left = Object.keys(sidebars);
  assert.deepEqual(left, [], `panels remained after clearing: ${left.join(", ")}`);
}

/**
 * The pair of tabs for the tab switch check. It looks in card or in another card for a tab of a plugin other than the active tab of card. When it finds one in another card,
 * from holds the id of that card. It fails when no tab of another plugin exists, because the check cannot run.
 */
export function tabSwitchPair(card, cards) {
  const original = card.tabs.find((tab) => tab.id === card.active);
  const own = card.tabs.find((tab) => tab.plugin !== original.plugin);
  if (own) return { original, other: own, from: card.id };
  const source = cards.find((item) => item.id !== card.id && item.tabs.some((tab) => tab.plugin !== original.plugin));
  assert.ok(source, `no tab of a plugin other than ${original.plugin} exists for the tab switch`);
  return { original, other: source.tabs.find((tab) => tab.plugin !== original.plugin), from: source.id };
}

/**
 * The DOM width of a top or bottom panel must equal the content column width of the card (the inner width of the card minus the width that the left and right sidebars occupy)
 * (docs/spec/example-model.md). A collapsed face occupies the divider width.
 */
export function requireContentWidth(rect, card, border, divider, side) {
  // default: a face that does not exist occupies no width.
  const extent = (state) => (state ? (state.collapsed ? divider : state.shownSize) : 0);
  const column = card.w - 2 * border - extent(card.sidebars?.left) - extent(card.sidebars?.right);
  assert.ok(Math.abs(rect.width - column) <= 1, `${side} panel is ${rect.width} wide, not the card's content column width ${column}`);
}

/**
 * The rectangle that the native surface of a card's active tab must take in the window: the card inside its border, below the head and
 * above the foot, less the extent of each side (docs/spec/example-model.md). plane is the origin of the plane in the window, and metrics
 * holds border, head, foot and divider in points. An open side takes its shown size, which is smaller than its stored size when the card
 * cannot hold both that size and the layout minimum of the content.
 */
export function panelSurfaceRect(plane, card, metrics) {
  const { border, head, foot, divider } = metrics;
  const band = (side) => (card.sidebars?.[side] ? (card.sidebars[side].collapsed ? divider : card.sidebars[side].shownSize) : 0);
  return {
    x: plane.x + card.x + border + band("left"),
    y: plane.y + card.y + border + head + band("top"),
    w: card.w - 2 * border - band("left") - band("right"),
    h: card.h - 2 * border - head - foot - band("top") - band("bottom"),
  };
}
