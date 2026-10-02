import assert from "node:assert/strict";
import test from "node:test";
import { glyphShape, outside, rasterRow, surfaceBoxes, whitePixels } from "./outside.mjs";
import { bare, cardSize } from "./surface.mjs";
import { assertHeldStatesShown, assertRoundTrips } from "./drag-measurement.mjs";

test("drag measurement rejects a stationary, incomplete, or non-returning gesture", () => {
  assert.throws(() => assertRoundTrips([100, 100, 100], 2), /moved only/);
  assert.throws(() => assertRoundTrips([100, 200, 100], 2), /far end/);
  assert.throws(() => assertRoundTrips([100, 200, 100, 200, 110], 2), /initial position/);
  assert.equal(assertRoundTrips([100, 150, 200, 150, 100, 150, 200, 150, 100], 2), 100);
});

test("every layout held for two frames must appear in the recording, and shorter ones may be replaced", () => {
  // 걸음은 16ms 간격이다. 0 → -10 → -20(세 걸음 유지) → -10 → 0(끝).
  const ticks = [0, 16, 32, 48, 64, 80];
  const boundary = [100, 90, 80, 80, 80, 90, 100];
  const sample = (time, offset) => ({ time, position: 200 + offset });
  const shown = [sample(-5, 0), sample(20, -10), sample(40, -20), sample(90, 0)];
  assertHeldStatesShown(shown, ticks, boundary);
  assert.throws(() => assertHeldStatesShown([sample(-5, 0), sample(90, 0)], ticks, boundary), /missing/,
    "the -20 layout held for 48ms must appear");
  assert.throws(() => assertHeldStatesShown([sample(-5, 0), sample(40, -20)], ticks, boundary), /missing/,
    "the final layout must appear");
});

test("a start position held for less than one presentation may be replaced between round trips", () => {
  // 왕복 사이의 시작 위치는 더 새 배치로 대신될 수 있다(docs/spec/native-surfaces.md). 먼 끝은 매 왕복 보인다.
  assert.equal(assertRoundTrips([100, 150, 200, 150, 200, 150, 100], 2), 100);
  assert.throws(() => assertRoundTrips([100, 150, 200, 200, 200, 150, 100], 2), /far end/);
  assert.throws(() => assertRoundTrips([150, 200, 150, 200, 150, 100], 2), /start/);
});

function fixture() {
  const frame = { width: 360, height: 160, stride: 1440, data: Buffer.alloc(1440 * 160) };
  const paint = (l, t, r, b, rgb) => {
    for (let y = t; y < b; y++) for (let x = l; x < r; x++) {
      const at = y * frame.stride + x * 4;
      frame.data.set([rgb[2], rgb[1], rgb[0], 255], at);
    }
  };
  paint(0, 0, 360, 160, [16, 17, 23]);
  for (const x of [10, 130, 250]) {
    paint(x, 10, x + 100, 150, [43, 46, 61]);
    paint(x + 1, 11, x + 99, 149, [25, 27, 36]);
    paint(x + 1, 40, x + 99, 130, [30, 30, 30]);
  }
  return { frame, paint };
}

test("composition measurement locates all three terminals in one frame", () => {
  const { frame } = fixture();
  const boxes = surfaceBoxes(frame, [30, 30, 30]);
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every((b) => b.l > b.card.l && b.r - 1 < b.card.r));
});

test("composition measurement uses the card header when terminal text hides its first background rows", () => {
  const { frame, paint } = fixture();
  paint(131, 40, 229, 85, [191, 191, 198]);
  const boxes = surfaceBoxes(frame, [30, 30, 30], { expectedRow: 9, rowTolerance: 5 });
  assert.equal(boxes.length, 3);
});

test("composition measurement detects one pixel of left border invasion", () => {
  const { frame, paint } = fixture();
  paint(130, 40, 131, 130, [30, 30, 30]);
  const boxes = surfaceBoxes(frame, [30, 30, 30]);
  assert.equal(boxes.length, 3);
  assert.equal(boxes.filter((b) => b.l <= b.card.l).length, 1);
});

test("composition measurement detects a one-pixel white stripe and a missing terminal", () => {
  const { frame, paint } = fixture();
  const area = { l: 11, r: 109, t: 40, b: 130 };
  assert.equal(whitePixels(frame, area), 0);
  paint(80, 40, 81, 130, [255, 255, 255]);
  assert.equal(whitePixels(frame, area), 90);
  paint(251, 40, 349, 130, [255, 255, 255]);
  assert.notEqual(surfaceBoxes(frame, [30, 30, 30]).length, 3);
});

test("glyph measurement distinguishes translation from stretching and missing text", () => {
  const { frame, paint } = fixture();
  const area = { l: 11, r: 40, t: 40, b: 70 };
  paint(15, 44, 20, 54, [204, 204, 204]);
  const normal = glyphShape(frame, area);
  paint(11, 40, 40, 70, [30, 30, 30]);
  paint(18, 48, 23, 58, [204, 204, 204]);
  assert.deepEqual(glyphShape(frame, area), normal);
  paint(18, 48, 26, 58, [204, 204, 204]);
  assert.notDeepEqual(glyphShape(frame, area), normal);
  paint(11, 40, 40, 70, [30, 30, 30]);
  assert.throws(() => glyphShape(frame, area), /no glyph/);
});

// 터미널의 기본 배경은 카드 색이다. 카드(테두리 10..110, 머리 행 20)와 그 안에서 측정용 배경으로 칠한 터미널
// 래스터(행 100..120)만 있는 프레임.
const MEASURED = [30, 30, 30];
function terminalFixture() {
  const frame = { width: 200, height: 160, stride: 800, scale: 1, data: Buffer.alloc(800 * 160) };
  const paint = (l, t, r, b, rgb) => {
    for (let y = t; y < b; y++) for (let x = l; x < r; x++) {
      frame.data.set([rgb[2], rgb[1], rgb[0], 255], y * frame.stride + x * 4);
    }
  };
  paint(0, 0, 200, 160, [16, 17, 23]);
  paint(10, 10, 111, 150, [43, 46, 61]);
  paint(11, 11, 110, 149, [25, 27, 36]);
  paint(11, 100, 110, 120, MEASURED);
  return { frame, paint, marks: { head: 20, top: 30, bottom: 130, cx: 85, colour: MEASURED } };
}

test("the raster row locates the measured terminal background and its overflow past the card", () => {
  const { frame, paint, marks } = terminalFixture();
  const inside = outside(frame, marks);
  assert.deepEqual({ out: inside.out, card: inside.card, surface: inside.surface },
    { out: 0, card: { l: 10, r: 110 }, surface: { l: 11, r: 109 } });
  // 래스터가 카드보다 3px 오른쪽으로 나가 테두리와 통로에 그려진 프레임.
  paint(109, 100, 114, 120, MEASURED);
  assert.equal(outside(frame, marks).out, 3);
});

test("the raster row reads the longest measured run from the empty rows at the bottom", () => {
  const { frame, paint } = terminalFixture();
  assert.deepEqual(rasterRow(frame, MEASURED, { from: 149, to: 30 }), { y: 119, l: 11, r: 109 });
  // 크기가 바뀌는 동안 이전 크기의 래스터가 왼쪽에 붙고 오른쪽은 카드 색으로 남는다.
  paint(90, 100, 110, 120, [25, 27, 36]);
  assert.deepEqual(rasterRow(frame, MEASURED, { from: 149, to: 30 }), { y: 119, l: 11, r: 89 });
  // 글자 획이 배경을 LINE 보다 짧게 나눈 행은 건너뛴다.
  for (let x = 30; x < 90; x += 30) paint(x, 119, x + 1, 120, [204, 204, 204]);
  assert.deepEqual(rasterRow(frame, MEASURED, { from: 149, to: 30 }), { y: 118, l: 11, r: 89 });
  assert.equal(rasterRow(frame, MEASURED, { from: 99, to: 30 }), null);
});

test("an unrendered white area next to the card color is found and card text is not", () => {
  const { frame, paint } = terminalFixture();
  assert.equal(bare(frame), 0);
  paint(40, 40, 70, 48, [236, 236, 245]);
  assert.equal(bare(frame), 0, "--fg text is not an unrendered area");
  paint(40, 60, 70, 68, [255, 255, 255]);
  assert.ok(bare(frame) > 0, "white next to the card color is an unrendered area");
});

test("the card size follows the card borders from a point in its header", () => {
  const { frame, paint } = terminalFixture();
  assert.deepEqual(cardSize(frame, { x: 85, y: 20 }), { width: 101, height: 130 });
  paint(10, 10, 60, 150, [16, 17, 23]);
  paint(60, 10, 61, 150, [43, 46, 61]);
  assert.deepEqual(cardSize(frame, { x: 85, y: 20 }), { width: 51, height: 130 });
});

test("the card size rejects a missing card but tolerates one covered probe pixel", () => {
  const { frame, paint } = terminalFixture();
  paint(84, 20, 87, 21, [16, 17, 23]);
  assert.deepEqual(cardSize(frame, { x: 85, y: 20 }), { width: 101, height: 130 });
  paint(10, 10, 111, 151, [16, 17, 23]);
  assert.equal(cardSize(frame, { x: 85, y: 20 }), null);
});
