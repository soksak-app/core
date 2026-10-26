import assert from "node:assert/strict";
import test from "node:test";

import { declaredSlotInsets, effectiveCardCornerRadiusPt, findFirstChangedSlotFrame, measureViewFrameGeometry }
  from "../view-frame-geometry.mjs";

const PALETTE = {
  contentColor: [30, 30, 30],
  cardColor: [25, 27, 36],
  planeColor: [16, 17, 23],
  borderColors: [[43, 46, 61], [34, 36, 47]],
  cornerRadiusPt: 0,
  colorTolerance: 0,
};

function recordedFrame({ card = { left: 10, top: 8, right: 90, bottom: 72 },
  content = { left: 14, top: 22, right: 86, bottom: 64 }, leftSlotGutter = false, roundedCorners = false,
  resumedBorderAfterPlaneGap = false, endpointCrossStroke = false, scale = 2,
  contentOrigin = { x: 0, y: 0 }, contentScale = 1 } = {}) {
  const width = 100;
  const height = 80;
  const stride = width * 4;
  const data = Buffer.alloc(stride * height);
  const paint = (x, y, color) => {
    const offset = y * stride + x * 4;
    data[offset] = color[2];
    data[offset + 1] = color[1];
    data[offset + 2] = color[0];
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, PALETTE.planeColor);
  for (let y = card.top; y < card.bottom; y++) for (let x = card.left; x < card.right; x++) {
    const edge = x === card.left || x === card.right - 1 || y === card.top || y === card.bottom - 1;
    paint(x, y, edge ? PALETTE.borderColors[0] : PALETTE.cardColor);
  }
  for (let y = content.top; y < content.bottom; y++) for (let x = content.left; x < content.right; x++) {
    paint(x, y, PALETTE.contentColor);
  }
  if (leftSlotGutter) {
    for (let y = card.top + 1; y < card.bottom - 1; y++) {
      for (let x = card.left + 1; x < content.left; x++) paint(x, y, PALETTE.planeColor);
      paint(card.left, y, PALETTE.borderColors[1]);
    }
  }
  if (roundedCorners) {
    const radius = 5;
    for (let y = 0; y < radius; y++) for (let x = 0; x < radius; x++) {
      const corners = [
        [card.left + radius, card.top + radius, card.left + x, card.top + y],
        [card.right - radius - 1, card.top + radius, card.right - 1 - x, card.top + y],
        [card.left + radius, card.bottom - radius - 1, card.left + x, card.bottom - 1 - y],
        [card.right - radius - 1, card.bottom - radius - 1, card.right - 1 - x, card.bottom - 1 - y],
      ];
      for (const [cx, cy, px, py] of corners) {
        if ((px - cx) ** 2 + (py - cy) ** 2 >= radius ** 2) paint(px, py, PALETTE.planeColor);
      }
    }
  }
  if (endpointCrossStroke) {
    for (let y = card.top - 1; y <= card.top + 1; y++) paint(card.left, y, PALETTE.borderColors[1]);
    for (let y = card.bottom - 2; y <= card.bottom; y++) paint(card.left, y, PALETTE.borderColors[1]);
    for (let x = card.left - 1; x <= card.left + 1; x++) {
      paint(x, card.top, PALETTE.borderColors[1]);
      paint(x, card.bottom - 1, PALETTE.borderColors[1]);
    }
  }
  if (resumedBorderAfterPlaneGap) {
    for (let x = card.left + 3; x < card.left + 6; x++) paint(x, card.top, PALETTE.planeColor);
  }
  return { width, height, stride, scale, contentScale, content: contentOrigin, time: 12.5, data };
}

function twoCardFrame({ extraTargetContent = false, fragmentedTarget = false, centerDifferentColor = false,
  outsideTargetContent = false, overdrawTargetToNeighbor = false } = {}) {
  const width = 210;
  const height = 90;
  const stride = width * 4;
  const data = Buffer.alloc(stride * height);
  const paint = (x, y, color) => {
    const offset = y * stride + x * 4;
    data[offset] = color[2];
    data[offset + 1] = color[1];
    data[offset + 2] = color[0];
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, PALETTE.planeColor);
  const card = (left, top, right, bottom) => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const edge = x === left || x === right - 1 || y === top || y === bottom - 1;
      paint(x, y, edge ? PALETTE.borderColors[0] : PALETTE.cardColor);
    }
  };
  const content = (left, top, right, bottom) => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) paint(x, y, PALETTE.contentColor);
  };
  card(10, 8, 95, 82);
  if (fragmentedTarget) {
    content(14, 22, 30, 35);
    content(32, 22, 91, 35);
    content(14, 37, 30, 78);
    content(32, 37, 91, 78);
  } else {
    content(14, 22, 91, 78);
  }
  if (overdrawTargetToNeighbor) content(90, 22, 106, 78);
  if (outsideTargetContent) content(20, 12, 30, 16);
  card(110, 8, 195, 82);
  content(114, 22, 191, 78);
  if (centerDifferentColor) {
    for (let y = 22; y < 78; y++) {
      const offset = y * stride + 52 * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }
  if (extraTargetContent) content(112, 30, 113, 31);
  return { width, height, stride, scale: 1, contentScale: 1, content: { x: 0, y: 0 }, time: 20, data };
}

test("recorded pixels measure content and outer card on all four edges", { timeout: 1000 }, () => {
  const measured = measureViewFrameGeometry(recordedFrame(), PALETTE);
  assert.deepEqual(measured.cardRectPx, { left: 10, top: 8, right: 90, bottom: 72 });
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 22, right: 86, bottom: 64 });
  assert.deepEqual(measured.cardRectPt, { left: 5, top: 4, right: 45, bottom: 36 });
  assert.deepEqual(measured.nativeRectPt, { left: 7, top: 11, right: 43, bottom: 32 });
  assert.equal(measured.timeMs, 12.5);
});

test("effective card radius follows public settings and removes the radius at zero gap", { timeout: 1000 }, () => {
  assert.equal(effectiveCardCornerRadiusPt({ radius: 8, gap: 4 }), 8);
  assert.equal(effectiveCardCornerRadiusPt({ radius: 8, gap: 0 }), 0);
  assert.throws(() => effectiveCardCornerRadiusPt({ radius: 8 }), /radius and gap/);
});

test("recorded pixels find the outer card boundary behind a plane-colored slot gutter", { timeout: 1000 }, () => {
  const measured = measureViewFrameGeometry(recordedFrame({ leftSlotGutter: true }), PALETTE);
  assert.deepEqual(measured.cardRectPx, { left: 10, top: 8, right: 90, bottom: 72 });
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 22, right: 86, bottom: 64 });
});

test("recorded pixels allow rounded corner prefixes and suffixes around a plane-colored slot gutter", { timeout: 1000 }, () => {
  const measured = measureViewFrameGeometry(recordedFrame({ leftSlotGutter: true, roundedCorners: true }),
    { ...PALETTE, cornerRadiusPt: 3 });
  assert.deepEqual(measured.cardRectPx, { left: 10, top: 8, right: 90, bottom: 72 });
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 22, right: 86, bottom: 64 });
});

test("recorded pixels reject an internal plane gap followed by a resumed border", { timeout: 1000 }, () => {
  assert.throws(() => measureViewFrameGeometry(recordedFrame({ resumedBorderAfterPlaneGap: true }),
    { ...PALETTE, cornerRadiusPt: 3 }),
    /corner stroke does not cross|complete card perimeter at top/);
});

test("recorded pixels accept rounded corner strokes only when their 2D palette component crosses the edge", { timeout: 1000 }, () => {
  const measured = measureViewFrameGeometry(recordedFrame({ roundedCorners: true, endpointCrossStroke: true }),
    { ...PALETTE, cornerRadiusPt: 3 });
  assert.deepEqual(measured.cardRectPx, { left: 10, top: 8, right: 90, bottom: 72 });
});

test("asymmetric content insets remain visible instead of being mistaken for aligned edges", { timeout: 1000 }, () => {
  const baseline = measureViewFrameGeometry(recordedFrame(), PALETTE);
  const shifted = measureViewFrameGeometry(recordedFrame({
    content: { left: 16, top: 25, right: 83, bottom: 61 },
  }), PALETTE);
  assert.deepEqual(baseline.cardRectPt, shifted.cardRectPt);
  assert.deepEqual(shifted.nativeRectPt, { left: 8, top: 12.5, right: 41.5, bottom: 30.5 });
  assert.deepEqual({
    left: shifted.nativeRectPt.left - shifted.cardRectPt.left,
    top: shifted.nativeRectPt.top - shifted.cardRectPt.top,
    right: shifted.nativeRectPt.right - shifted.cardRectPt.right,
    bottom: shifted.nativeRectPt.bottom - shifted.cardRectPt.bottom,
  }, { left: 3, top: 8.5, right: -3.5, bottom: -5.5 });
});

test("geometry measurement rejects missing content and a card edge clipped by the raster", { timeout: 1000 }, () => {
  const missingContent = recordedFrame();
  missingContent.data.fill(0);
  assert.throws(() => measureViewFrameGeometry(missingContent, PALETTE), /content/);
  assert.throws(() => measureViewFrameGeometry(recordedFrame({
    card: { left: 0, top: 8, right: 90, bottom: 72 },
  }), PALETTE), /card.*edge|edge.*card/);
});

test("geometry measurement rejects ambiguous content colors and an overdraw that hides the card edge", { timeout: 1000 }, () => {
  const ambiguous = recordedFrame();
  const offset = 2 * ambiguous.stride + 2 * 4;
  ambiguous.data[offset] = PALETTE.contentColor[2];
  ambiguous.data[offset + 1] = PALETTE.contentColor[1];
  ambiguous.data[offset + 2] = PALETTE.contentColor[0];
  ambiguous.data[offset + 3] = 255;
  assert.throws(() => measureViewFrameGeometry(ambiguous, PALETTE), /separate.*content-color/);

  assert.throws(() => measureViewFrameGeometry(recordedFrame({
    content: { left: 8, top: 22, right: 86, bottom: 64 },
  }), PALETTE), /card left edge/);
});

test("geometry measurement selects the anchored card when another visible card has the same content fill", { timeout: 1000 }, () => {
  const targetRect = { x: 110, y: 8, width: 85, height: 74 };
  const measured = measureViewFrameGeometry(twoCardFrame(), { ...PALETTE, targetRect });
  assert.deepEqual(measured.cardRectPx, { left: 110, top: 8, right: 195, bottom: 82 });
  assert.deepEqual(measured.nativeRectPx, { left: 114, top: 22, right: 191, bottom: 78 });
  const overdraw = measureViewFrameGeometry(twoCardFrame({ extraTargetContent: true }), { ...PALETTE, targetRect });
  assert.deepEqual(overdraw.nativeRectPx, { left: 112, top: 22, right: 191, bottom: 78 });
});

test("geometry measurement unions fragmented target fill while excluding an equally colored other card", { timeout: 1000 }, () => {
  const targetRect = { x: 10, y: 8, width: 85, height: 74 };
  const measured = measureViewFrameGeometry(twoCardFrame({ fragmentedTarget: true }), { ...PALETTE, targetRect });
  assert.deepEqual(measured.cardRectPx, { left: 10, top: 8, right: 95, bottom: 82 });
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 22, right: 91, bottom: 78 });
});

test("geometry measurement includes same-card color components outside the declared target rectangle", { timeout: 1000 }, () => {
  const frame = twoCardFrame({ outsideTargetContent: true });
  const targetRect = { x: 14, y: 22, width: 77, height: 56 };
  const measured = measureViewFrameGeometry(frame, { ...PALETTE, targetRect });
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 12, right: 91, bottom: 78 });
});

test("geometry measurement rejects an obscured edge that would otherwise select a neighboring card", { timeout: 1000 }, () => {
  const frame = twoCardFrame({ overdrawTargetToNeighbor: true });
  assert.throws(() => measureViewFrameGeometry(frame, { ...PALETTE,
    targetRect: { x: 14, y: 22, width: 77, height: 56 } }), /card right edge.*plane-colored gap/);
});

test("geometry measurement finds a target card when its center is not the content fill", { timeout: 1000 }, () => {
  const targetRect = { x: 10, y: 8, width: 85, height: 74 };
  const measured = measureViewFrameGeometry(twoCardFrame({ centerDifferentColor: true }), { ...PALETTE, targetRect });
  assert.deepEqual(measured.cardRectPx, { left: 10, top: 8, right: 95, bottom: 82 });
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 22, right: 91, bottom: 78 });
});

test("anchored geometry measures the complete selected content rectangle without clipping overdraw", { timeout: 1000 }, () => {
  const expanded = twoCardFrame();
  const stride = expanded.stride;
  for (let y = 20; y < 28; y++) for (let x = 190; x < 200; x++) {
    const offset = y * stride + x * 4;
    expanded.data[offset] = PALETTE.contentColor[2];
    expanded.data[offset + 1] = PALETTE.contentColor[1];
    expanded.data[offset + 2] = PALETTE.contentColor[0];
    expanded.data[offset + 3] = 255;
  }
  const measured = measureViewFrameGeometry(expanded, { ...PALETTE,
    targetRect: { x: 114, y: 22, width: 77, height: 56 } });
  assert.deepEqual(measured.nativeRectPx, { left: 114, top: 20, right: 200, bottom: 78 });
  assert.deepEqual(measured.cardRectPx, { left: 110, top: 8, right: 195, bottom: 82 });
});

test("content-color islands enclosed by an opaque glyph remain part of the measured rectangle", { timeout: 1000 }, () => {
  const frame = recordedFrame();
  const paint = (x, y, color) => {
    const offset = y * frame.stride + x * 4;
    frame.data[offset] = color[2];
    frame.data[offset + 1] = color[1];
    frame.data[offset + 2] = color[0];
    frame.data[offset + 3] = 255;
  };
  for (let y = 31; y < 38; y++) for (let x = 41; x < 48; x++) {
    if (x === 41 || x === 47 || y === 31 || y === 37) paint(x, y, [0, 0, 0]);
  }
  const measured = measureViewFrameGeometry(frame, PALETTE);
  assert.deepEqual(measured.nativeRectPx, { left: 14, top: 22, right: 86, bottom: 64 });
});

test("point rectangles account for capture content origin and content scaling", { timeout: 1000 }, () => {
  const measured = measureViewFrameGeometry(recordedFrame({
    contentOrigin: { x: 3, y: 4 },
    contentScale: 2,
  }), PALETTE);
  assert.deepEqual(measured.cardRectPt, { left: 1, top: 0, right: 21, bottom: 16 });
  assert.deepEqual(measured.nativeRectPt, { left: 2, top: 3.5, right: 20, bottom: 14 });
});

test("declared slot insets derive from composition and card rectangles, including local child DOM geometry", { timeout: 1000 }, () => {
  const grid = { plane: { x: 10, y: 20 }, cards: [{ id: "card-1", x: 5, y: 7, w: 200, h: 100 }] };
  const surfaces = [{ surface: "view-1", declared: { x: 20, y: 36, w: 184, h: 72 },
    applied: { x: 18, y: 34, w: 186, h: 74 } }];
  assert.deepEqual(declaredSlotInsets({ grid, surfaces, card: "card-1", surface: "view-1" }),
    { left: 5, top: 9, right: 11, bottom: 19 });
  assert.deepEqual(declaredSlotInsets({ grid, surfaces, card: "card-1", surface: "view-1",
    regionRect: { x: 25, y: 38, w: 160, h: 60 } }),
  { left: 12, top: 13, right: 28, bottom: 27 });
  assert.throws(() => declaredSlotInsets({ grid, surfaces: [], card: "card-1", surface: "view-1" }),
    /missing declared composition geometry/);
});

test("layout timing finds the first changed card frame and first pixel-aligned declared slot", { timeout: 1000 }, () => {
  const card = (right) => ({ left: 0, top: 0, right, bottom: 80 });
  const native = (right) => ({ left: 5, top: 10, right, bottom: 70 });
  const geometry = [
    { timeMs: 10, cardRectPt: card(100), nativeRectPt: native(95) },
    { timeMs: 20, cardRectPt: card(100), nativeRectPt: native(95) },
    { timeMs: 30, cardRectPt: card(110), nativeRectPt: native(95) },
    { timeMs: 40, cardRectPt: card(110), nativeRectPt: native(105) },
  ];
  assert.deepEqual(findFirstChangedSlotFrame(geometry, {
    beforeChangeTimeMs: 25, slotInsetsPt: { left: 5, top: 10, right: 5, bottom: 10 },
  }), { baselineFrameIndex: 1, changeFrameIndex: 2, contentFrameIndex: 3,
    slotMatchFrameIndices: [3], maxSlotErrorPt: 0 });
});
