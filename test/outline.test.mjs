import assert from "node:assert/strict";
import test from "node:test";

import { contains, outline, unionLoops } from "../dist/index.js";
import { three } from "./helpers.mjs";

const arcs = (path) => (path.match(/A/g) ?? []).length;

test("cards separated by a corridor need pad to close into one shape", () => {
  const grid = three();
  const rects = ["sidebar", "terminal"].map((id) => grid.rect(id));
  const half = grid.gap / 2;

  assert.equal(outline(rects, { pad: 0 }).loops.length, 2, "borders alone stay apart");
  assert.equal(outline(rects, { pad: half - 1 }).loops.length, 2, "just short is still apart");
  assert.equal(outline(rects, { pad: half }).loops.length, 1, "half a corridor closes it");
  assert.equal(outline(rects, { pad: half + 6 }).loops.length, 1);
});

test("binding two cards at right angles gives a rounded L", () => {
  const grid = three();
  const rects = ["sidebar", "terminal"].map((id) => grid.rect(id));
  const shape = outline(rects, { pad: grid.gap / 2, radius: 14 + grid.gap / 2 });
  assert.equal(shape.loops.length, 1);
  assert.equal(shape.loops[0].length, 6, "an L has six corners");
  assert.equal(shape.sharp, 0, "every right angle is rounded");
  assert.equal(arcs(shape.path), 6);
});

test("a card left out of the outline stays outside it", () => {
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

test("a coordinate carrying float error still meets its neighbour", () => {
  // 812.0000000000001 is what the grid returns for a line at 812. Rounding the
  // vertex key but not the grid line left two lines one key apart, and the loop
  // came back as three points instead of six.
  const rail = { x: 812.0000000000001, y: 0, w: 190, h: 534 };
  const focused = { x: 1026, y: 290, w: 574, h: 244 };
  const shape = outline([rail, focused], { pad: 12, radius: 26, innerRadius: 12 });
  assert.equal(shape.loops.length, 1);
  assert.equal(shape.loops[0].length, 6, "an L has six corners");
  assert.equal(shape.sharp, 0);
});

test("the loop runs outside every rect it binds", () => {
  const rects = [
    { x: 812.0000000000001, y: 0, w: 190, h: 534 },
    { x: 1026, y: 290, w: 574, h: 244 },
  ];
  const others = [
    { x: 0, y: 0, w: 190, h: 534 },
    { x: 214, y: 0, w: 574, h: 266 },
    { x: 1026, y: 0, w: 574, h: 266 },
    { x: 1624, y: 0, w: 210, h: 534 },
  ];
  const { loops } = outline(rects, { pad: 12, radius: 26, innerRadius: 12 });
  let inside = 0;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6));
      for (let t = 0; t <= steps; t++) {
        const x = a.x + ((b.x - a.x) * t) / steps;
        const y = a.y + ((b.y - a.y) * t) / steps;
        if (others.some((r) => x > r.x + 2 && x < r.x + r.w - 2 && y > r.y + 2 && y < r.y + r.h - 2)) inside++;
      }
    }
  }
  assert.equal(inside, 0);
});

test("the radius drawn at a corner is the one asked for, and which kind it is", () => {
  // An L: six corners, five convex and one reflex. Swapping the two radii, or
  // scaling either, changes the arcs and nothing else, so the path must be read
  // for the values and not only counted.
  const shape = outline(
    [
      { x: 0, y: 0, w: 400, h: 100 },
      { x: 0, y: 100, w: 100, h: 300 },
    ],
    { pad: 0, radius: 30, innerRadius: 8 },
  );
  assert.equal(shape.loops.length, 1);
  assert.equal(shape.loops[0].length, 6);
  assert.equal(shape.sharp, 0);

  const radii = [...shape.path.matchAll(/A([\d.]+) /g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  assert.equal(radii.length, 6, "one arc per corner");
  assert.deepEqual(radii, [8, 30, 30, 30, 30, 30], "one reflex corner at 8, five convex at 30");

  // The cap: half the shorter of the two sides meeting there.
  const tight = outline([{ x: 0, y: 0, w: 400, h: 40 }], { pad: 0, radius: 100, innerRadius: 4 });
  const capped = [...tight.path.matchAll(/A([\d.]+) /g)].map((m) => Number(m[1]));
  assert.deepEqual(capped, [20, 20, 20, 20], "capped at half the 40px side");

  // Below half a px it is cut straight and counted.
  const flat = outline([{ x: 0, y: 0, w: 400, h: 0.6 }], { pad: 0, radius: 30, innerRadius: 4 });
  assert.equal(flat.sharp, 4);
  assert.equal([...flat.path.matchAll(/A/g)].length, 0, "and no arc is emitted");
});
