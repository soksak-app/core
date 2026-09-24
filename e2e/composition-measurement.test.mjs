import assert from "node:assert/strict";
import test from "node:test";
import { glyphShape, surfaceBoxes, whitePixels } from "./outside.mjs";
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
