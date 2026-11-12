import assert from "node:assert/strict";
import test from "node:test";
import { glyphShape, measuredRun, outside, rasterRow, surfaceBoxes, whitePixels } from "../outside.mjs";
import { bare, cardSize } from "../surface.mjs";
import { assertHeldStatesShown, assertRoundTrips } from "@soksak/window-check/drag-measurement.mjs";

test("drag measurement rejects a stationary, incomplete, or non-returning gesture", () => {
  assert.throws(() => assertRoundTrips([100, 100, 100], 2), /moved only/);
  assert.throws(() => assertRoundTrips([100, 200, 100], 2), /far end/);
  assert.throws(() => assertRoundTrips([100, 200, 100, 200, 110], 2), /initial position/);
  assert.equal(assertRoundTrips([100, 150, 200, 150, 100, 150, 200, 150, 100], 2), 100);
});

/** The still rows (readStills) of a recording that wrote a still every `gap` ms from `from` to `to`, none of them lost. */
const writtenStills = (from, to, gap = 8) => Array.from({ length: Math.floor((to - from) / gap) + 1 }, (_, index) => {
  const planned = from + index * gap;
  return { index, planned, requested: planned, completed: planned + 0.5, gap, outcome: "written", error: null, late: false };
});

test("every layout held for two frames must appear in the recording, and shorter ones may be replaced", () => {
  // The fixture ticks are 16 ms apart. The host paces real drag steps by the display period of the window, so no step has a fixed length.
  const ticks = [0, 16, 32, 48, 64, 80];
  const boundary = [100, 90, 80, 80, 80, 90, 100];
  const sample = (time, offset) => ({ time, position: 200 + offset });
  const stills = writtenStills(-8, 96);
  const shown = [sample(-5, 0), sample(20, -10), sample(40, -20), sample(90, 0)];
  assertHeldStatesShown(shown, ticks, boundary, stills);
  assert.throws(() => assertHeldStatesShown([sample(-5, 0), sample(90, 0)], ticks, boundary, stills), /missing/,
    "the -20 layout held for 48ms must appear");
  assert.throws(() => assertHeldStatesShown([sample(-5, 0), sample(40, -20)], ticks, boundary, stills), /missing/,
    "the final layout must appear");
});

test("a missing held layout names its hold, the step times, the boundary positions and the times of the recorded frames", () => {
  // The step times and the frame times are on the clock of the layout trace, so a failure can be laid over the transactions.
  const ticks = [1000, 1016.25, 1032.5, 1048.75, 1065, 1081.25];
  const boundary = [100, 90, 80, 80, 80, 90, 100];
  const sample = (time, offset) => ({ time, position: 200 + offset });
  assert.throws(() => assertHeldStatesShown([sample(995, 0), sample(1090.4, 0)], ticks, boundary, writtenStills(992, 1096)), (error) => {
    assert.match(error.message, /-20 held 1016\.3\.\.1065\.0/, "the missing layout names when it was held");
    assert.match(error.message, /the recording lost no still in that time/, "the message names the stills lost in that time");
    assert.match(error.message, /steps at 1000\.0,1016\.3,1032\.5,1048\.8,1065\.0,1081\.3/, "the message names the step times");
    assert.match(error.message, /boundary 100,90,80,80,80,90,100/, "the message names the boundary positions");
    assert.match(error.message, /recorded 995\.0:0,1090\.4:0/, "the message names the time and offset of each frame");
    return true;
  });
});

test("a start position held for less than one presentation may be replaced between round trips", () => {
  // The start position between round trips can be replaced by a newer layout (docs/spec/native-surfaces.md). The far end is visible in every round trip.
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

// The default background of the terminal is the card color. A frame that has only the card (border 10..110, head row 20) and, inside it, the terminal
// raster (rows 100..120) painted with the measurement background.
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
  // A frame in which the raster goes 3px to the right beyond the card and is drawn on the border and the gutter.
  paint(109, 100, 114, 120, MEASURED);
  assert.equal(outside(frame, marks).out, 3);
});

test("the raster row reads the longest measured run from the empty rows at the bottom", () => {
  const { frame, paint } = terminalFixture();
  assert.deepEqual(rasterRow(frame, MEASURED, { from: 149, to: 30 }), { y: 119, l: 11, r: 109 });
  // While the size changes, the raster of the previous size sticks to the left and the right stays in the card color.
  paint(90, 100, 110, 120, [25, 27, 36]);
  assert.deepEqual(rasterRow(frame, MEASURED, { from: 149, to: 30 }), { y: 119, l: 11, r: 89 });
  // A row where a glyph stroke divides the background into runs shorter than LINE is skipped.
  for (let x = 30; x < 90; x += 30) paint(x, 119, x + 1, 120, [204, 204, 204]);
  assert.deepEqual(rasterRow(frame, MEASURED, { from: 149, to: 30 }), { y: 118, l: 11, r: 89 });
  assert.equal(rasterRow(frame, MEASURED, { from: 99, to: 30 }), null);
});

test("the measured run of a surface ends at its last measured row, above a measured row of another surface", () => {
  const { frame, paint } = terminalFixture();
  // A lower surface below the measured one shows one row in the measured color at its bottom, as the bottom device row of a document
  // region that its page does not cover shows the default background of the web view, rgb(30, 30, 30).
  paint(11, 140, 110, 141, MEASURED);
  // The walk from the bottom of the window finds that row and not the measured surface.
  assert.deepEqual(rasterRow(frame, MEASURED, { from: 159, to: 30 }), { y: 140, l: 11, r: 109 });
  assert.deepEqual(measuredRun(frame, MEASURED, { from: 30, to: 160 }), { y: 119, l: 11, r: 109 });
  // While the size changes, the raster of the previous size sticks to one side of the region.
  paint(90, 110, 110, 120, [25, 27, 36]);
  assert.deepEqual(measuredRun(frame, MEASURED, { from: 30, to: 160 }), { y: 119, l: 11, r: 89 });
  assert.equal(measuredRun(frame, MEASURED, { from: 30, to: 100 }), null);
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
