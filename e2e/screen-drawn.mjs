// Reads from the frames of a recording whether a window shows a completely drawn screen (docs/spec/surface-composition.md). It looks at two places in each frame.
// The logo text of the head row must be in its place to the right of the traffic light buttons (before the application style applies, the logo is pushed toward
// the buttons), and the card head must have the card color (if the workspace is empty, only the window background shows).
import assert from "node:assert/strict";

import { pixel } from "@soksak/window-check/frame.mjs";

/** The area of the logo text, to the right of the logo icon in the window head row (window points). If the logo is pushed toward the traffic light buttons, this area is empty. */
export const LOGO = { x: 112, y: 13, width: 48, height: 12 };

/** Whether the colors a and b differ by at most tolerance in each channel. */
export const near = (a, b, tolerance) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

/** The point at the head of the first card with tabs of core.grid that must have the card color (window points). */
export function cardPoint(grid) {
  const content = grid.cards.find((item) => item.tabs?.length);
  assert.ok(content, `no content card in ${JSON.stringify(grid.cards)}`);
  return { x: grid.plane.x + content.x + content.w / 2, y: grid.plane.y + content.y + 3 };
}

/** The buffer position of the window coordinate (points) point. */
function position(frame, point) {
  const scale = frame.scale * frame.contentScale;
  return { x: Math.floor(frame.content.x * frame.scale + point.x * scale), y: Math.floor(frame.content.y * frame.scale + point.y * scale) };
}

/** The frame pixel at the window coordinate (points) point. */
export function sample(frame, point) {
  const { x, y } = position(frame, point);
  return pixel(frame, x, y);
}

/** The alpha of the frame pixel at the window coordinate (points) point: 0 where the window is transparent, as a new window is before its reveal. */
export function alpha(frame, point) {
  const { x, y } = position(frame, point);
  return frame.data[y * frame.stride + x * 4 + 3];
}

/** The number of pixels inside rect (window coordinates) that differ from background by more than 40. */
export function ink(frame, rect, background) {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (sample(frame, { x, y }).some((value, index) => Math.abs(value - background[index]) > 40)) count++;
    }
  }
  return count;
}

/**
 * The incompletely drawn frames of captured. logo is the area of the logo text in its place, and card is one point that must have the card color (it is not
 * examined when null). The background of the logo and the card color are read from reference, which must show the logo.
 */
export function undrawn(captured, { logo, card, reference }) {
  const background = sample(reference, { x: logo.x - 4, y: logo.y + logo.height / 2 });
  const cardColour = card ? sample(reference, card) : null;
  assert.ok(ink(reference, logo, background) > 0, "the reference frame has no logo text at its place");
  return captured.map((frame, index) => ({ index, logo: ink(frame, logo, background), card: card ? sample(frame, card) : null }))
    .filter((item) => item.logo === 0 || (card && !near(item.card, cardColour, 12)))
    .map((item) => ({ ...item, expected: cardColour }));
}

/**
 * frame, a frame of a display recording whose display has its origin at display (screen points), read in the coordinates of the window at
 * rect (screen points), so the window points of LOGO and cardPoint sample it.
 */
export function inWindow(frame, display, rect) {
  return { ...frame, content: { x: frame.content.x + (rect.x - display.x) * frame.contentScale,
    y: frame.content.y + (rect.y - display.y) * frame.contentScale, width: rect.width, height: rect.height } };
}

/**
 * Whether a window of size (points) shows at its full size in view, a frame read in its coordinates: the middle of each edge, 2 points
 * inside the window, has the pixel of the frame last. While the window opening animation draws the window smaller, those points show
 * what lies around it.
 */
export function fullSize(view, last, size) {
  const points = [{ x: size.width / 2, y: 2 }, { x: size.width / 2, y: size.height - 3 }, { x: 2, y: size.height / 2 },
    { x: size.width - 3, y: size.height / 2 }];
  return points.every((point) => near(sample(view, point), sample(last, point), 12));
}
