import assert from "node:assert/strict";
import test from "node:test";

import { viewEdgeFaults } from "../view-edges.mjs";

const COLORS = { view: "0050b4", lines: ["2b2e3d", "ffb36b"] };

// The device pixels across the four edges of a view at scale 2, in a still of each host: a run is at:colourxcount. A web view host paints
// through a display surface, so its line is 2c2e3d where the declared colour and the mygo host have 2b2e3d.
const STILLS = {
  "mygo half": { frame: {x: 210.0, y: 116.0, w: 373.0, h: 286.3999938964844},
    left: "414:101117x4 418:2b2e3dx2 420:0050b4x7",
    right: "1160:0050b4x6 1166:2b2e3dx2 1168:101117x5",
    top: "226:191b24x4 230:2b2e3dx2 232:0050b4x7",
    bottom: "798:0050b4x6 804:191b24x1 805:2b2e3dx2 807:191b24x4" },
  "mygo fractional": { frame: {x: 227.39999389648438, y: 116.0, w: 355.6000061035156, h: 286.3999938964844},
    left: "448:101117x5 453:2b2e3dx2 455:191b24x1 456:0050b4x5",
    right: "1160:0050b4x6 1166:2b2e3dx2 1168:101117x5",
    top: "226:191b24x4 230:2b2e3dx2 232:0050b4x7",
    bottom: "798:0050b4x6 804:191b24x1 805:2b2e3dx2 807:191b24x4" },
  "wails half": { frame: {x: 210.0, y: 116.0, w: 373.5, h: 287.0},
    left: "414:101118x4 418:2c2e3dx2 420:0050b4x7",
    right: "1161:0050b4x6 1167:2c2e3dx2 1169:101118x5",
    top: "226:191b24x2 228:2c2e3dx2 230:191b24x2 232:0050b4x7",
    bottom: "800:0050b4x6 806:191b24x7" },
  "tauri half": { frame: {x: 210.0, y: 116.0, w: 373.0, h: 286.5},
    left: "414:101118x4 418:2c2e3dx2 420:0050b4x7",
    right: "1160:0050b4x6 1166:2c2e3dx2 1168:101118x5",
    top: "226:191b24x4 230:2c2e3dx2 232:0050b4x7",
    bottom: "799:0050b4x6 805:2c2e3dx2 807:191b24x5" },
  "tauri fractional": { frame: {x: 227.5, y: 116.0, w: 355.5, h: 286.5},
    left: "449:101118x4 453:2c2e3dx2 455:0050b4x7",
    right: "1160:0050b4x6 1166:2c2e3dx2 1168:101118x5",
    top: "226:191b24x4 230:2c2e3dx2 232:0050b4x7",
    bottom: "799:0050b4x6 805:2c2e3dx2 807:191b24x5" }
};

const colors = (runs) => {
  const pixels = new Map();
  for (const run of runs.split(" ")) {
    const [, at, hex, count] = run.match(/^(\d+):([0-9a-f]{6})x(\d+)$/);
    for (let k = 0; k < Number(count); k++) pixels.set(Number(at) + k, [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  }
  return pixels;
};

/** An image of the runs of a still: a pixel is read across the edge that it belongs to, as the check reads only those. */
function imageOf(still) {
  const across = new Map([...colors(still.left), ...colors(still.right)]), along = new Map([...colors(still.top), ...colors(still.bottom)]);
  return { pixel: (x, y) => across.get(x) ?? along.get(y) ?? assert.fail(`the still holds no pixel ${x},${y}`) };
}

const faults = (name) => viewEdgeFaults(imageOf(STILLS[name]), STILLS[name].frame, 2, COLORS);

test("a view that touches the lines of its card has no fault", () => {
  assert.deepEqual(faults("tauri half"), []);
  assert.deepEqual(faults("tauri fractional"), []);
});

test("a row of the card inside the slot of a view is a fault", () => {
  assert.deepEqual(faults("mygo half"), ["bottom: the pixel 793,804 inside the view is 191b24, not 0050b4"]);
  assert.deepEqual(faults("mygo fractional"), [
    "left: the pixel 455,518 inside the view is 191b24, not 0050b4",
    "bottom: the pixel 810,804 inside the view is 191b24, not 0050b4",
  ]);
});

test("a row of the card between a view and its line is a fault", () => {
  assert.deepEqual(faults("wails half"), [
    "top: the pixel 793,231 outside the view is 191b24, not one of 2b2e3d, ffb36b",
    "bottom: the pixel 793,806 outside the view is 191b24, not one of 2b2e3d, ffb36b",
  ]);
});

test("a colour may move two levels and no more", () => {
  const frame = { x: 5, y: 5, w: 8, h: 8 };
  // The line of the frame at the scale 2 lies on the pixels 9 and 26, so the image paints its outside at those.
  const image = (line) => ({ pixel: (x, y) => (x === 9 || x === 26 || y === 9 || y === 26 ? line : [0, 0x50, 0xb4]) });
  assert.deepEqual(viewEdgeFaults(image([0x2d, 0x30, 0x3f]), frame, 2, COLORS), []);
  assert.equal(viewEdgeFaults(image([0x2e, 0x2e, 0x3d]), frame, 2, COLORS).length, 4);
});
