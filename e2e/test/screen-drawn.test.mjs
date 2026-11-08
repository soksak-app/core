import assert from "node:assert/strict";
import test from "node:test";

import { beforeReveal, cardPoint, LOGO, sample, undrawn, visible } from "../screen-drawn.mjs";

const BACKGROUND = [20, 20, 30];
const CARD = [43, 46, 61];

/**
 * A frame of a 200 x 60 point window at scale 2 inside a buffer with a margin of 4 points. logo draws the logo text, card colors the window point card,
 * and alpha is the opacity of every pixel.
 */
function frame({ logo = true, card = null, cardColour = CARD, alpha = 255 } = {}) {
  const scale = 2, margin = 4, width = (200 + margin) * scale, height = (60 + margin) * scale, stride = width * 4;
  const data = Buffer.alloc(stride * height);
  const paint = (x, y, [red, green, blue]) => data.set([blue, green, red, alpha], y * stride + x * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, BACKGROUND);
  const fill = (rect, colour) => {
    for (let y = (margin + rect.y) * scale; y < (margin + rect.y + rect.height) * scale; y++) {
      for (let x = (margin + rect.x) * scale; x < (margin + rect.x + rect.width) * scale; x++) paint(x, y, colour);
    }
  };
  if (logo) fill({ x: LOGO.x + 10, y: LOGO.y + 4, width: 6, height: 4 }, [230, 230, 230]);
  if (card) fill({ x: card.x - 1, y: card.y - 1, width: 2, height: 2 }, cardColour);
  return { width, height, stride, content: { x: margin, y: margin, width: 200, height: 60 }, contentScale: 1, scale, time: 0, data };
}

test("a sample reads the pixel at a window point through the content rectangle and the scale", () => {
  const card = { x: 50, y: 40 };
  assert.deepEqual(sample(frame({ card }), card), CARD);
  assert.deepEqual(sample(frame({ card }), { x: 40, y: 40 }), BACKGROUND);
});

test("the card point is at the head of the first card with tabs, on the plane", () => {
  const grid = { plane: { x: 10, y: 30 }, cards: [{ x: 0, y: 0, w: 100, tabs: [] }, { x: 200, y: 50, w: 120, tabs: [{ id: "t" }] }] };
  assert.deepEqual(cardPoint(grid), { x: 270, y: 83 });
  assert.throws(() => cardPoint({ plane: { x: 0, y: 0 }, cards: [{ x: 0, y: 0, w: 10, tabs: [] }] }), /no content card/);
});

test("undrawn names the frames without the logo or without the card color of the reference", () => {
  const card = { x: 50, y: 40 };
  const reference = frame({ card });
  const found = undrawn([frame({ card }), frame({ card, logo: false }), frame({ card, cardColour: BACKGROUND }), reference],
    { logo: LOGO, card, reference });
  assert.deepEqual(found.map((item) => item.index), [1, 2]);
  assert.equal(found[0].logo, 0);
  assert.deepEqual(found[1].card, BACKGROUND);
  assert.deepEqual(found[1].expected, CARD);
  assert.deepEqual(undrawn([frame(), frame({ logo: false })], { logo: LOGO, card: null, reference: frame() }).map((item) => item.index), [1]);
});

test("undrawn rejects a reference without the logo at its place", () => {
  assert.throws(() => undrawn([frame()], { logo: LOGO, card: null, reference: frame({ logo: false }) }), /reference frame has no logo/);
});

test("a window is visible in a frame unless its logo area is fully transparent", () => {
  assert.equal(visible(frame(), LOGO), true);
  assert.equal(visible(frame({ alpha: 0 }), LOGO), false);
});

test("the records before the reveal are the idle, blank and invisible frames before the first frame that shows the window", () => {
  const shows = (name) => name === "shown";
  const records = [
    { sequence: 4, status: 0, frame: "shown" },
    { sequence: 1, status: 4, frame: null },
    { sequence: 2, status: 2, frame: null },
    { sequence: 3, status: 0, frame: "transparent" },
    { sequence: 5, status: 1, frame: null },
  ];
  assert.deepEqual(beforeReveal(records, shows).map((record) => record.sequence), [2, 3]);
  // A recording that started after the window went on the screen has nothing before its first frame.
  assert.deepEqual(beforeReveal([{ sequence: 1, status: 4, frame: null }, { sequence: 2, status: 0, frame: "shown" },
    { sequence: 3, status: 1, frame: null }], shows), []);
  assert.throws(() => beforeReveal([{ sequence: 1, status: 2, frame: null }], shows), /no recorded frame shows the window/);
});
