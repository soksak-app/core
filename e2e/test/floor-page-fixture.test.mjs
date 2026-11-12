import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkViewPage, validateManifest } from "@soksak/plugin-api";
import { dragGeometryFrame, FLOOR_COLOUR, FLOOR_PAGE, measureFloorLayoutFrame, openFloorPage, writeDragLayouts }
  from "../benchmark/cases/floor-page.mjs";
import { findFirstChangedSlotFrame } from "@soksak/window-check/view-frame-geometry.mjs";

const read = (path) => readFileSync(join(FLOOR_PAGE.folder, path), "utf8");

test("the floor page is a view whose page draws the measurement colour and runs no code but the declaration of its composition", { timeout: 5000 }, () => {
  const manifest = JSON.parse(read("plugin.json"));
  validateManifest(manifest);
  assert.equal(manifest.id, FLOOR_PAGE.plugin);
  assert.deepEqual(manifest.surface, { composition: { kind: "view", page: "ui/page.html" } });
  assert.equal(manifest.exposes, undefined);
  const page = read("ui/page.html");
  checkViewPage(page);
  assert.deepEqual([...page.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag), ['<script type="module" src="./start.js">']);
  assert.match(page, new RegExp(`background:\\s*rgb\\(${FLOOR_COLOUR.join(",\\s*")}\\)`));
  const start = read("ui/start.js");
  assert.deepEqual([...start.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, from]) => from), ["@soksak/plugin-api/view"]);
  assert.match(start, /^await bridge\.composition\.create\(\);$/m);
});

test("the floor page opens as the active tab of the focused card, which a fixture configuration has installed, and its cleanup closes it", { timeout: 5000 }, async () => {
  const calls = [];
  const cleanups = [];
  const grid = { cards: [{ id: "c1", focused: false, active: "s1" }, { id: "c2", focused: true, active: "s9" }] };
  const s = {
    cleanup: (fn) => { cleanups.push(fn); },
    get: async (name) => {
      calls.push(`get ${name}`);
      return grid;
    },
    run: async (name, params) => {
      calls.push(`run ${name} ${JSON.stringify(params)}`);
      return name === "core.card.add-tab" ? { tab: "s9" } : null;
    },
    until: async (name, predicate, message) => {
      const value = { "core.grid": grid, "core.surfaces": [{ surface: "s9", status: { phase: "ready" } }] }[name];
      assert.ok(predicate(value), message);
      calls.push(`until ${name}`);
      return value;
    },
  };
  assert.deepEqual(await openFloorPage(s), { surface: "s9", card: "c2" });
  assert.deepEqual(calls, [
    "get core.grid",
    'run core.card.add-tab {"card":"c2","plugin":"floorpage"}',
    "until core.grid",
    "until core.surfaces",
  ]);
  calls.length = 0;
  for (const cleanup of cleanups.toReversed()) await cleanup();
  assert.deepEqual(calls, ['run core.tab.close {"tab":"s9"}']);
  grid.cards[1].focused = false;
  await assert.rejects(openFloorPage(s), new Error("the start layout has no focused card for the floor page"));
});

function floorLayoutFrame({ cardLeft, rootLeft, time }) {
  const width = 1024;
  const height = 768;
  const stride = width * 4;
  const data = Buffer.alloc(stride * height);
  const plane = [16, 17, 23];
  const cardColor = [25, 27, 36];
  const edgeColor = [43, 46, 61];
  const focusCornerBlend = [32, 28, 29];
  const paint = (x, y, [red, green, blue]) => {
    const offset = y * stride + x * 4;
    data[offset] = blue;
    data[offset + 1] = green;
    data[offset + 2] = red;
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, plane);
  const card = { left: cardLeft, top: 16, right: 950, bottom: 647 };
  for (let y = card.top; y < card.bottom; y++) for (let x = card.left; x < card.right; x++) {
    const edge = x < card.left + 2 || x >= card.right - 2 || y < card.top + 2 || y >= card.bottom - 2;
    paint(x, y, edge ? edgeColor : cardColor);
  }
  const content = { left: rootLeft, top: 82, right: 948, bottom: 601 };
  for (let y = content.top; y < content.bottom; y++) {
    for (let x = content.left; x < content.right; x++) paint(x, y, FLOOR_COLOUR);
  }
  for (const x of [card.left + 9, card.right - 10]) {
    for (const y of [card.top + 2, card.bottom - 3]) paint(x, y, focusCornerBlend);
  }
  // A still of the recording, requested at `time` and completed 0.5ms later.
  return { width, height, stride, scale: 2, contentScale: 1, content: { x: 0, y: 0 }, requested: time, completed: time + 0.5, data };
}

test("floor page layout geometry excludes captured focus-corner colors from content bounds", { timeout: 5000 }, () => {
  const before = measureFloorLayoutFrame(floorLayoutFrame({ cardLeft: 200, rootLeft: 202, time: 10 }), {
    cornerRadiusPt: 8, targetRect: { x: 101, y: 41, width: 373, height: 259.5 },
  });
  const after = measureFloorLayoutFrame(floorLayoutFrame({ cardLeft: 40, rootLeft: 42, time: 20 }), {
    cornerRadiusPt: 8, targetRect: { x: 21, y: 41, width: 453, height: 259.5 },
  });
  let slotError = null;
  let slotMatch;
  try {
    slotMatch = findFirstChangedSlotFrame([before, after], { beforeChangeTimeMs: 15,
      slotInsetsPt: { left: 1, top: 33, right: 1, bottom: 23 } });
  } catch (error) {
    slotError = error.message;
  }
  assert.deepEqual({ before: before.nativeRectPt, after: after.nativeRectPt, slotError, slotMatch }, {
    before: { left: 101, top: 41, right: 474, bottom: 300.5 },
    after: { left: 21, top: 41, right: 474, bottom: 300.5 },
    slotError: null,
    slotMatch: {
      baselineFrameIndex: 0, changeFrameIndex: 1, contentFrameIndex: 1,
      slotMatchFrameIndices: [1], maxSlotErrorPt: 0,
    },
  });
});

test("drag layout evidence is written before frame analysis", { timeout: 5000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "drag-layouts-"));
  try {
    const layouts = [{ ticket: 4, begun: 10, presented: 26, committed: 30 }];
    const path = writeDragLayouts(directory, layouts);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { layouts });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("drag geometry keeps four measured card and view edges from the same captured frame", { timeout: 5000 }, () => {
  assert.deepEqual(dragGeometryFrame(7, {
    timeMs: 148,
    cardRectPt: { left: 10, top: 20, right: 209.5, bottom: 180 },
    nativeRectPt: { left: 11, top: 21, right: 208.5, bottom: 179 },
  }, { left: 1, top: 1, right: 1, bottom: 1 }), {
    frameIndex: 7,
    timeMs: 148,
    cardRectPt: { left: 10, top: 20, right: 209.5, bottom: 180 },
    nativeRectPt: { left: 11, top: 21, right: 208.5, bottom: 179 },
    contentRectPt: { left: 11, top: 21, right: 208.5, bottom: 179 },
    slotInsetsPt: { left: 1, top: 1, right: 1, bottom: 1 },
    contentInsetsPt: { left: 0, top: 0, right: 0, bottom: 0 },
  });
});
