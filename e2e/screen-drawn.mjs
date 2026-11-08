// Reads from the frames of a window recording whether the window shows a completely drawn screen (docs/spec/surface-composition.md). It looks at two places in each frame.
// The logo text of the head row must be in its place to the right of the traffic light buttons (before the application style applies, the logo is pushed toward
// the buttons), and the card head must have the card color (if the workspace is empty, only the window background shows).
import assert from "node:assert/strict";

import { pixel } from "@soksak/window-check/frame.mjs";

/** The area of the logo text, to the right of the logo icon in the window head row (window points). If the logo is pushed toward the traffic light buttons, this area is empty. */
export const LOGO = { x: 112, y: 13, width: 48, height: 12 };

/** The SCFrameStatus values of a callback status record (docs/spec/endpoint.md). */
const COMPLETE = 0, IDLE = 1, BLANK = 2;

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
 * Whether the window is visible in the frame: some pixel of the logo area is not fully transparent. A window that the host keeps transparent until its
 * first screen (window_reveal.m) is recorded with no opacity, and the screen shows what lies behind it.
 */
export function visible(frame, logo) {
  for (let y = logo.y; y < logo.y + logo.height; y++) {
    for (let x = logo.x; x < logo.x + logo.width; x++) {
      const at = position(frame, { x, y });
      if (frame.data[at.y * frame.stride + at.x * 4 + 3] !== 0) return true;
    }
  }
  return false;
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
 * The callback records of a recording (callback-status.jsonl) that come before the first frame that shows the window: idle and blank callbacks, and complete
 * frames in which the window is not visible. shows(name) says whether the written frame name shows the window. A recording that started after the window
 * went on the screen has none. Rejects a recording without a frame that shows the window.
 */
export function beforeReveal(records, shows) {
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  const shown = (record) => record.status === COMPLETE && record.frame !== null && shows(record.frame);
  const first = ordered.findIndex(shown);
  assert.ok(first >= 0, `no recorded frame shows the window: ${JSON.stringify(ordered.map((record) => record.status))}`);
  return ordered.slice(0, first).filter((record) => record.status === IDLE || record.status === BLANK ||
    (record.status === COMPLETE && record.frame !== null));
}
