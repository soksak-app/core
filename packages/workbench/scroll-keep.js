// Keeps the scroll position when the content is the same after a redraw (docs/spec/settings.md). A scrolling element states the visible content with data-scroll-key.
// The same key means the same content, and a different key starts at the top. An element with data-scroll-end
// starts at the end when the key differs.

/** Reads the scroll position by key for each data-scroll-key element inside root. */
export function scrollPositions(root) {
  const positions = new Map();
  for (const element of root.querySelectorAll("[data-scroll-key]")) {
    positions.set(element.dataset.scrollKey, { top: element.scrollTop, left: element.scrollLeft });
  }
  return positions;
}

/** Restores the position of the data-scroll-key elements inside root whose key also exists in positions. */
export function restoreScroll(root, positions) {
  for (const element of root.querySelectorAll("[data-scroll-key]")) {
    const position = positions.get(element.dataset.scrollKey);
    if (!position) {
      // Content that asks for its end (data-scroll-end), as a log does, starts there when its key is new.
      if (element.dataset.scrollEnd !== undefined) element.scrollTop = element.scrollHeight;
      continue;
    }
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  }
}
