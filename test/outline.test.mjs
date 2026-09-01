import assert from "node:assert/strict";
import test from "node:test";

import { contains, outline, unionLoops } from "../dist/index.js";
import { three } from "./helpers.mjs";

const arcs = (path) => (path.match(/A/g) ?? []).length;

test("panes separated by a corridor need pad to close into one shape", () => {
  const grid = three();
  const rects = ["sidebar", "terminal"].map((id) => grid.rect(id));
  const half = grid.gap / 2;

  assert.equal(outline(rects, { pad: 0 }).loops.length, 2, "borders alone stay apart");
  assert.equal(outline(rects, { pad: half - 1 }).loops.length, 2, "just short is still apart");
  assert.equal(outline(rects, { pad: half }).loops.length, 1, "half a corridor closes it");
  assert.equal(outline(rects, { pad: half + 6 }).loops.length, 1);
});

test("binding two panes at right angles gives a rounded L", () => {
  const grid = three();
  const rects = ["sidebar", "terminal"].map((id) => grid.rect(id));
  const shape = outline(rects, { pad: grid.gap / 2, radius: 14 + grid.gap / 2 });
  assert.equal(shape.loops.length, 1);
  assert.equal(shape.loops[0].length, 6, "an L has six corners");
  assert.equal(shape.sharp, 0, "every right angle is rounded");
  assert.equal(arcs(shape.path), 6);
});

test("a pane left out of the outline stays outside it", () => {
  const grid = three();
  for (const [inside, outsideId] of [
    ["terminal", "browser"],
    ["browser", "terminal"],
  ]) {
    const shape = outline(
      ["sidebar", inside].map((id) => grid.rect(id)),
      { pad: grid.gap / 2 },
    );
    const r = grid.rect(outsideId);
    for (const [x, y] of [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x, r.y + r.h],
      [r.x + r.w, r.y + r.h],
    ]) {
      assert.equal(contains(shape.loops, x, y), false, `${outsideId} corner leaked in`);
    }
    const bound = grid.rect(inside);
    assert.equal(contains(shape.loops, bound.x + bound.w / 2, bound.y + bound.h / 2), true);
  }
});

test("a single rect gives one four-corner loop", () => {
  const shape = outline([{ x: 10, y: 20, w: 100, h: 60 }], { pad: 4, radius: 8 });
  assert.equal(shape.loops.length, 1);
  assert.equal(shape.loops[0].length, 4);
  assert.equal(shape.sharp, 0);
  assert.equal(arcs(shape.path), 4);
});

test("touching rects merge; the shared edge leaves no seam", () => {
  const loops = unionLoops([
    { x: 0, y: 0, w: 50, h: 50 },
    { x: 50, y: 0, w: 50, h: 50 },
  ]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4, "the merged shape is a plain rectangle");
});

test("no rects means no outline", () => {
  const shape = outline([]);
  assert.deepEqual(shape.loops, []);
  assert.equal(shape.path, "");
});
