// Measures the unrendered surface area inside a frame and the size of the terminal card.
//
// The default background of the terminal surface is the same color as the card (--card) (see the background check of terminal.test.mjs). In the midnight theme nothing in the window is
// white, so a white pixel adjacent to the card color is a place that the web view has not rendered yet.
import { pixel } from "@soksak/window-check/frame.mjs";

/** Default background of the card and the terminal surface. It is --card (#191b24) of the midnight theme. */
const CARD = [25, 27, 36];

/** Background of the board. The passage between cards has this color. It is --bg (#101117) of the midnight theme. */
const PLANE = [16, 17, 23];

/** A color that deviates by more than this amount is not that color. */
const NEAR = 4;

/**
 * Brightness judged as white. The glyph color --fg (#ececf5) of the card has red and green of 236, so only unrendered white (255)
 * exceeds this value.
 */
const PALE = 248;

/**
 * If the card color and white are adjacent within this distance, there is no card border between them.
 *
 * The passage of the midnight theme is 6px. Looking farther than that reaches the card across the passage, so the distance must be shorter than the passage.
 */
const REACH = 3;

const near = (px, colour) => px.every((v, i) => Math.abs(v - colour[i]) <= NEAR);
const pale = ([r, g, b]) => r > PALE && g > PALE && b > PALE;

/**
 * Number of white pixels adjacent to the card color in this frame.
 *
 * Right next to the background of the card and the surface are the header, the footer and the border of the card, which are all dark. White adjacent to that background inside the surface is only
 * a place that is not rendered yet. It is not necessary to know which area of the window it is, so the same criterion is
 * used for the vertical drag and the horizontal drag.
 */
export function bare(frame) {
  let n = 0;
  for (let y = REACH; y < frame.height - REACH; y += 2) {
    for (let x = REACH; x < frame.width - REACH; x += 2) {
      if (!near(pixel(frame, x, y), CARD)) continue;
      if (pale(pixel(frame, x + REACH, y)) || pale(pixel(frame, x - REACH, y)) ||
          pale(pixel(frame, x, y + REACH)) || pale(pixel(frame, x, y - REACH))) {
        n++;
      }
    }
  }
  return n;
}

/**
 * Width and height (points) of the terminal card. From one point of the card header (x, y in points), it walks left, right and down until the passage appears.
 * While dragging the left or bottom boundary of the terminal card, that point is inside the card. It is null if it cannot be measured.
 */
export function cardSize(frame, { x, y }) {
  const cx = Math.round(x * frame.scale), cy = Math.round(y * frame.scale);
  const plane = (px, py) => near(pixel(frame, px, py), PLANE);
  // Even if the card is still nearby, the compositor edge can cover the declared probe.
  // The device pixels nearby are tried. A card that really does not exist
  // remains in the state that cannot be measured.
  const candidates = [cx, cx - 1, cx + 1, cx - 2, cx + 2, cx - 8, cx + 8, cx - 16, cx + 16]
    .filter((probe) => probe >= 0 && probe < frame.width && !plane(probe, cy));
  let best = null;
  for (const probe of candidates) {
    const walk = (start, step, limit, at) => {
      let position = start;
      let solid = start;
      let gap = 0;
      while (position + step >= 0 && position + step < limit) {
        const next = position + step;
        if (!plane(next, at)) {
          position = next;
          solid = next;
          gap = 0;
          continue;
        }
        if (++gap > 4) break;
        position = next;
      }
      return solid;
    };
    const l = walk(probe, -1, frame.width, cy);
    const r = walk(probe, 1, frame.width, cy);
    let b = cy;
    while (b + 1 < frame.height && !plane(probe, b + 1)) b++;
    const measured = { width: (r - l + 1) / frame.scale, height: (b - cy + 1) / frame.scale };
    if (best === null || measured.width > best.width) best = measured;
  }
  return best;
}
