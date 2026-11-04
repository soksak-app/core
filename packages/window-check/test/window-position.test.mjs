import assert from "node:assert/strict";
import test from "node:test";

import { windowPosition } from "../app.mjs";

// A visible work area below a menu bar and a window of the start size of a check.
const AREA = { x: 0, y: 25, width: 1512, height: 920 };
const FRAME = { x: 300, y: 200, width: 1200, height: 788 };

test("windowPosition gives each of the three applications its own position inside the visible area", () => {
  const positions = ["wailsv3", "tauriv2", "mygo"].map((name) => [name, windowPosition(name, AREA, FRAME)]);
  assert.deepEqual(Object.fromEntries(positions), {
    wailsv3: { x: 0, y: 25 },
    tauriv2: { x: 312, y: 25 },
    mygo: { x: 156, y: 25 },
  });
  const keys = new Set(positions.map(([, { x, y }]) => `${x},${y}`));
  assert.equal(keys.size, 3, `two applications share a position: ${JSON.stringify(positions)}`);
  for (const [name, { x, y }] of positions) {
    assert.ok(x >= AREA.x && x + FRAME.width <= AREA.x + AREA.width, `${name} lies outside the area horizontally: ${x}`);
    assert.ok(y >= AREA.y && y + FRAME.height <= AREA.y + AREA.height, `${name} lies outside the area vertically: ${y}`);
  }
});

test("windowPosition centres mygo on whole points in an area of odd remaining width", () => {
  assert.deepEqual(windowPosition("mygo", { x: -1440, y: 0, width: 1441, height: 900 }, FRAME), { x: -1320, y: 0 });
});

test("windowPosition rejects an application that has no window position", () => {
  assert.throws(() => windowPosition("other", AREA, FRAME), /windowPosition: unknown application other/);
});
