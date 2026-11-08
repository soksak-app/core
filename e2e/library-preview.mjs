// The panes of the library preview of the start layout of a window check (packages/window-check/start.mjs) and their gaps, which
// docs/spec/projects.md#project-identity states as uniform.

/**
 * The preview panes `{left, upper, lower, right}` of the start layout: the fixed sidebars left and right and between them two
 * content cards, one above the other. `grid` is core.grid and `preview` the panes `{id, x, y, w, h}` of the project in core.library.
 * The upper and the lower card stand by the geometry of the grid, not by the focus: the start state focuses the card of its last
 * replaced placeholder, which is the lower one.
 */
export function startPreviewPanes(grid, preview) {
  const content = grid.cards.filter((card) => !card.fixed && card.tabs?.length > 0).sort((a, b) => a.y - b.y);
  const [upper, lower] = content;
  if (content.length !== 2 || upper.x !== lower.x || upper.w !== lower.w || upper.y + upper.h > lower.y) {
    throw new Error(`the start layout holds no two content cards one above the other: ${JSON.stringify(grid.cards)}`);
  }
  const pane = (id) => {
    const found = preview.find((c) => c.id === id);
    if (!found) throw new Error(`the preview has no pane of the card ${id}`);
    return found;
  };
  return { left: pane("left"), upper: pane(upper.id), lower: pane(lower.id), right: pane("right") };
}

/** The gaps of the preview panes: left sidebar to the upper card, the upper card to the right sidebar, the upper card to the lower. */
export function previewGaps({ left, upper, lower, right }) {
  return [upper.x - left.x - left.w, right.x - upper.x - upper.w, lower.y - upper.y - upper.h];
}
