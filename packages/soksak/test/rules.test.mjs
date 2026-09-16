import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { H, W, fuzz, three } from "./helpers.mjs";

/**
 * One test per rule in the layout specification.
 *
 * A rule nothing checks is decoration: it survives a rewrite that breaks it, and
 * the next reader believes it. Each of these names the rule it is in service of,
 * so a failure names the rule that was broken rather than the line that moved.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("R1 — two cards that meet report the same coordinate, exactly", () => {
  for (let seed = 0; seed < 40; seed++) {
    const grid = three();
    fuzz(grid, seed, 60);
    for (const axis of ["x", "y"]) {
      const [lo, hi] = axis === "x" ? ["c0", "c1"] : ["r0", "r1"];
      for (let line = 1; line < grid.lines(axis).length - 1; line++) {
        const ends = grid.cards
          .filter((c) => c[hi] === line)
          .map((c) => (axis === "x" ? grid.rectOf(c).x + grid.rectOf(c).w : grid.rectOf(c).y + grid.rectOf(c).h));
        const starts = grid.cards
          .filter((c) => c[lo] === line)
          .map((c) => (axis === "x" ? grid.rectOf(c).x : grid.rectOf(c).y));
        for (const group of [ends, starts]) {
          if (group.length < 2) continue;
          assert.equal(
            Math.max(...group) - Math.min(...group),
            0,
            `seed ${seed}: ${axis}${line} is in two places`,
          );
        }
      }
    }
  }
});

test("R2 — a role is two predicates, and the code reads no other card field", () => {
  // No branch anywhere may turn on a card's id or its position in the list.
  for (const file of ["src/card.ts", "src/geometry.ts", "src/slicing.ts", "src/soksak.ts"]) {
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /\.id\s*===\s*['"]/, `${file} branches on a particular id`);
    assert.doesNotMatch(code, /id\s*===\s*['"](left|right|rail|sidebar)['"]/, `${file} compares a card id to a place name`);
  }
  // And a fixed-size card returns the same values as a sharing one.
  const grid = new Soksak(
    {
      xs: [0, 0.3, 1],
      ys: [0, 1],
      cards: [
        { id: "side", c0: 0, c1: 1, r0: 0, r1: 1, width: 180, fixed: true },
        { id: "main", c0: 1, c1: 2, r0: 0, r1: 1 },
      ],
    },
    { width: W, height: H },
  );
  for (const id of ["side", "main"]) {
    const r = grid.rect(id);
    for (const v of [r.x, r.y, r.w, r.h]) assert.ok(Number.isFinite(v), `${id} has no rect`);
    assert.equal(typeof grid.crossings(grid.card(id)), "number");
  }
});

test("R3 — no card ever spans over a card, and the check is integers", () => {
  for (let seed = 0; seed < 30; seed++) {
    const grid = three();
    fuzz(grid, seed, 50);
    for (const axis of ["x", "y"]) {
      for (let line = 0; line < grid.lines(axis).length; line++) {
        // Against the operation, not against the expression the predicate is
        // written in: a card is placed exactly where the predicate allows.
        const copy = Soksak.from(grid.toJSON(), { width: W, height: H });
        const said = grid.canInsertAt(axis, line);
        const went = copy.insertAt(axis, line, { size: 40, id: "probe" }) !== null;
        // The predicate reports whether a card spans over the line, not whether
        // the plane has the room, so a true answer can still be refused for
        // room. A false one may never go in.
        if (!said) assert.equal(went, false, `seed ${seed}: ${axis}${line} refused, insertAt went`);
        if (!went) continue;
        // Nothing was cut: every card that was there keeps its span across.
        const [alo, ahi] = axis === "x" ? ["r0", "r1"] : ["c0", "c1"];
        for (const was of grid.cards) {
          const now = copy.card(was.id);
          assert.ok(now, `seed ${seed}: ${was.id} survived`);
          assert.deepEqual([now[alo], now[ahi]], [was[alo], was[ahi]], `${was.id} was cut`);
        }
      }
    }
  }
  // Dragging moves coordinates and can never change the answer.
  const grid = three();
  grid.split("terminal", "x");
  const before = ["x", "y"].map((a) => grid.standings(a).join(","));
  for (const d of grid.dividers()) {
    grid.moveBoundary(d.axis, d.line, grid.boundaryPos(d.axis, d.line) + 200);
    grid.moveBoundary(d.axis, d.line, grid.boundaryPos(d.axis, d.line) - 400);
  }
  assert.deepEqual(["x", "y"].map((a) => grid.standings(a).join(",")), before);
});

/**
 * Can these spans be cut apart by whole-width and whole-height cuts?
 *
 * Worked out here rather than asked of the grid: `isSlicing` is the answer
 * under test, and a test that asks the implementation for it passes whatever
 * the implementation defines.
 */
function guillotine(spans) {
  if (spans.length <= 1) return true;
  for (const [lo, hi] of [["c0", "c1"], ["r0", "r1"]]) {
    for (const line of [...new Set(spans.map((s) => s[lo]))].sort((a, b) => a - b)) {
      const before = spans.filter((s) => s[hi] <= line);
      const after = spans.filter((s) => s[lo] >= line);
      if (before.length && after.length && before.length + after.length === spans.length) {
        return guillotine(before) && guillotine(after);
      }
    }
  }
  return false;
}

test("R4 — nothing reachable is outside what splitting could build", () => {
  for (let seed = 0; seed < 60; seed++) {
    const grid = three();
    fuzz(grid, seed, 60);
    const spans = grid.cards.map(({ c0, c1, r0, r1 }) => ({ c0, c1, r0, r1 }));
    assert.ok(guillotine(spans), `seed ${seed}: no cut separates ${JSON.stringify(spans)}`);
    assert.equal(grid.isSlicing(), true, `seed ${seed}: and the grid agrees`);
  }
});

test("R4 — a pinwheel is not reachable, and isSlicing returns false", () => {
  // Four cards around a hole: no whole-width or whole-height cut separates any
  // of them. Without this the fuzz above would prove nothing about the check.
  const pinwheel = [
    { c0: 0, c1: 2, r0: 0, r1: 1 },
    { c0: 2, c1: 3, r0: 0, r1: 2 },
    { c0: 1, c1: 3, r0: 2, r1: 3 },
    { c0: 0, c1: 1, r0: 1, r1: 3 },
  ];
  assert.equal(guillotine(pinwheel), false, "the check can fail");
  const grid = new Soksak(
    {
      xs: [0, 0.3, 0.6, 1],
      ys: [0, 0.3, 0.6, 1],
      cards: pinwheel.map((s, i) => ({ id: `p${i}`, ...s })),
    },
    { width: 900, height: 900 },
  );
  assert.equal(grid.isSlicing(), false, "and so does the grid");
});

test("R4 — a cut counts only when both halves are themselves sliceable", () => {
  // The top row is one card across the plane, so the plane cuts in two there.
  // Below it sits a pinwheel, which no cut separates. A check that accepted the
  // top cut without looking under it would call this sliceable.
  const spans = [
    { c0: 0, c1: 3, r0: 0, r1: 1 },
    { c0: 0, c1: 2, r0: 1, r1: 2 },
    { c0: 2, c1: 3, r0: 1, r1: 3 },
    { c0: 1, c1: 3, r0: 3, r1: 4 },
    { c0: 0, c1: 1, r0: 2, r1: 4 },
  ];
  assert.equal(guillotine(spans), false, "the cut under the top row is missing");
  const grid = new Soksak(
    {
      xs: [0, 0.3, 0.6, 1],
      ys: [0, 0.25, 0.5, 0.75, 1],
      cards: spans.map((s, i) => ({ id: `c${i}`, ...s })),
    },
    { width: 900, height: 900 },
  );
  assert.equal(grid.isSlicing(), false, "and the grid does not stop at the top cut");
});

test("R5 — the corridor is half a gap inside, and nothing at the plane's border", () => {
  for (const gap of [0, 8, 24, 48]) {
    for (let seed = 0; seed < 12; seed++) {
      const grid = three({ gap });
      fuzz(grid, seed, 40);
      const rects = [...grid.rects().values()];
      // every border of the plane is touched, and touched flush
      const edges = {
        left: Math.min(...rects.map((r) => r.x)),
        top: Math.min(...rects.map((r) => r.y)),
        right: Math.max(...rects.map((r) => r.x + r.w)),
        bottom: Math.max(...rects.map((r) => r.y + r.h)),
      };
      assert.equal(edges.left, 0, `gap ${gap} seed ${seed}: left border`);
      assert.equal(edges.top, 0, `gap ${gap} seed ${seed}: top border`);
      assert.ok(Math.abs(edges.right - grid.width) < 0.01, `gap ${gap} seed ${seed}: right border`);
      assert.ok(Math.abs(edges.bottom - grid.height) < 0.01, `gap ${gap} seed ${seed}: bottom border`);

      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
          const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
          const apart = Math.max(dx, dy);
          if (apart < 0) continue;
          assert.ok(
            Math.abs(apart - gap) < 0.5 || apart > gap,
            `gap ${gap} seed ${seed}: two cards are ${apart} apart`,
          );
        }
      }
    }

    // The corridor is the plane's rule, so a card never pays for it: a declared
    // size draws that size at the border, between two cards, and at any gap.
    for (let seed = 0; seed < 12; seed++) {
      const grid = new Soksak(
        {
          xs: [0, 0.25, 0.5, 0.75, 1],
          ys: [0, 0.5, 1],
          cards: [
            { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
            { id: "rail", c0: 1, c1: 2, r0: 0, r1: 2, width: 190, fixed: true },
            { id: "main", c0: 2, c1: 3, r0: 0, r1: 1 },
            { id: "under", c0: 2, c1: 3, r0: 1, r1: 2 },
            { id: "right", c0: 3, c1: 4, r0: 0, r1: 2, width: 200, fixed: true },
          ],
        },
        { width: 1200, height: 600, gap },
      );
      // Dragging a sidebar's own boundary is the user resizing it, so the
      // number may change. What may never change is what the number means: it
      // is drawn at exactly that while the plane can give it, and when it
      // cannot, every px card is drawn at the same multiple of what it asked.
      const multiples = () =>
        ["left", "rail", "right"]
          .map((id) => grid.card(id))
          .filter((c) => c && c.width !== undefined && c.c1 - c.c0 === 1)
          .map((c) => grid.rect(c.id).w / c.width);
      const agree = (when) => {
        const m = multiples();
        if (!m.length) return;
        assert.ok(
          Math.max(...m) - Math.min(...m) < 0.001,
          `gap ${gap} seed ${seed} ${when}: drawn at ${m.map((v) => v.toFixed(3))}`,
        );
      };
      agree("at the start");
      for (const m of multiples()) {
        assert.ok(Math.abs(m - 1) < 0.001, `gap ${gap} seed ${seed}: drawn at ${m} with room to spare`);
      }
      fuzz(grid, seed, 40);
      agree("after fuzzing");
    }
  }
});

test("R6 — no coordinate is assembled outside geometry.ts", () => {
  const code = read("src/soksak.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  // an object literal carrying all four rect fields is a rect being built by hand
  assert.doesNotMatch(code, /\bx:\s*[^,]+,\s*y:\s*[^,]+,\s*w:\s*[^,]+,\s*h:/, "soksak.ts builds a rect");
  assert.doesNotMatch(code, /\bw:\s*[^,]+,\s*h:\s*[^,}]+\s*}/, "soksak.ts sizes a rect");
  for (const file of ["src/card.ts", "src/slicing.ts"]) {
    const other = read(file).replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.doesNotMatch(other, /\bx:\s*[^,]+,\s*y:/, `${file} builds a rect`);
  }
});

test("R7 — every open card but the last can leave, whatever came before", () => {
  for (let seed = 0; seed < 80; seed++) {
    const grid = three();
    fuzz(grid, seed, 60);
    const open = grid.cards.filter((c) => !c.fixed);
    if (open.length <= 1) continue;
    for (const card of open) {
      assert.ok(grid.canClose(card.id), `seed ${seed}: ${card.id} is stranded`);
    }
  }
});

// A ledger, not a behaviour check: it compares two documents and would pass on
// any implementation. It is here so a rule cannot be stated without a test.
test("the rules the layout specification states and the rules named by a test are the same list", () => {
  const readme = read("docs/spec/layout.md");
  const stated = [...readme.matchAll(/\*\*(R\d) — /g)].map((m) => m[1]);
  const tested = read("test/rules.test.mjs").match(/test\("(R\d) —/g)?.map((s) => s.slice(6, 8)) ?? [];
  assert.deepEqual(stated, [...new Set(tested)], "a rule is stated without a test, or tested without being stated");
});

test("R1 — the plane's own borders are not lines a card may take away", () => {
  // A card leaving the last slot took the line at 1.0 with it, so the plane
  // itself got shorter and every position after that was measured against a
  // border that had moved.
  const grid = new Soksak(undefined, { width: 1200, height: 800 });
  grid.split("card", "x");
  grid.splitToward("card", "left");
  grid.moveTo("card-2", "x", 2);
  grid.moveTo("card-1", "x", 1);

  const xs = grid.lines("x");
  assert.equal(xs[0], 0, `the plane still starts at 0: [${xs}]`);
  assert.equal(xs[xs.length - 1], 1, `and still ends at 1: [${xs}]`);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] >= xs[i - 1], `lines stay in order: [${xs}]`);
  }

  const [min, max] = grid.boundaryRange("x", 2);
  assert.ok(min <= max, `a boundary's range is not empty: [${min}, ${max}]`);

  grid.centerBoundary("x", 2);
  for (const [id, r] of grid.rects()) {
    assert.ok(r.w > 0 && r.h > 0, `${id} has area after centring: ${JSON.stringify(r)}`);
  }
});

test("R3 — a split puts its line inside the card being cut, and nowhere else", () => {
  // Searching the whole line array for the insertion point found an index
  // outside the card whenever two lines shared a coordinate, so the card ended
  // up with an inverted span and two cards genuinely overlapped.
  const grid = new Soksak(undefined, { width: 1200, height: 800, gap: 0, minSize: 0 });
  grid.splitToward("card", "top");
  grid.split("card-1", "y");
  grid.moveTo("card-1", "y", 2);
  grid.split("card-1", "y");

  for (const c of grid.cards) {
    assert.ok(c.c0 < c.c1, `${c.id} spans nothing across: [${c.c0}, ${c.c1}]`);
    assert.ok(c.r0 < c.r1, `${c.id} spans nothing down: [${c.r0}, ${c.r1}]`);
  }
  const rects = [...grid.rects().entries()];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [ia, a] = rects[i];
      const [ib, b] = rects[j];
      const over =
        Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.ok(over < 0.01, `${ia} and ${ib} overlap by ${over.toFixed(0)}px²`);
    }
  }
});

test("a line no card reads costs nothing, and a corridor never outgrows the plane", () => {
  // A corridor separates two cards. A remembered boundary separates nothing.
  const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24 });
  grid.split("card", "x");
  // Two rows, so the bottom one still spans the line after the close.
  const rows = new Soksak(
    { xs: [0, 0.5, 1], ys: [0, 0.5, 1], cards: [
      { id: "a", c0: 0, c1: 1, r0: 0, r1: 1 },
      { id: "b", c0: 1, c1: 2, r0: 0, r1: 1 },
      { id: "under", c0: 0, c1: 2, r0: 1, r1: 2 },
    ] },
    { width: 1200, height: 600, gap: 24 },
  );
  rows.close("b");
  assert.ok(
    rows.lines("x").some((_, i) => i > 0 && i < rows.lines("x").length - 1 && rows.isVirtual("x", i)),
    "the closed card left its line",
  );
  assert.equal(rows.rect("a").w, rows.width, "and the line takes no width from the row above");
  assert.equal(rows.rect("under").w, rows.width, "nor from the row below");

  // and when the plane is smaller than the corridors, the corridors give way
  for (const px of [200, 40, 10, 1, 0]) {
    const small = new Soksak(undefined, { width: 1200, height: 600, gap: 24 });
    small.split("card", "x");
    small.split("card-1", "x");
    small.resize(px, px);
    for (const [id, r] of small.rects()) {
      assert.ok(r.w >= 0 && r.h >= 0, `plane ${px}: ${id} is ${r.w}x${r.h}`);
    }
  }
});

test("R7 — a card stays only when the layout was told not to touch what would take its place", () => {
  // The one exception, pinned so it cannot widen quietly. `fixed` is the host
  // saying the layout may not move a card, so it will not grow it over a
  // departing neighbour either.
  const grid = new Soksak(undefined, { width: 1600, height: 1200 });
  grid.split("card", "x");
  grid.split("card-1", "x");
  grid.split("card-2", "y");
  grid.split("card", "y");

  for (const c of grid.cards) assert.equal(grid.canClose(c.id), true, `${c.id} can leave`);

  grid.setFixed("card", true);
  assert.equal(grid.canClose("card-4"), false, "its only filler may not be moved");
  assert.equal(grid.close("card-4"), false, "and the close agrees");

  grid.setFixed("card", false);
  assert.equal(grid.canClose("card-4"), true, "and it leaves the moment that is lifted");
});

test("a card added and closed leaves the plane as it was", () => {
  // split, splitToward and insertAt each take the new card's span from one
  // neighbour. Closing it returns the span to that neighbour.
  const start = () => {
    const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24 });
    grid.split("card", "x");
    return grid;
  };
  const widths = (grid) => grid.cards.map((c) => +grid.rect(c.id).w.toFixed(3));

  for (const [name, round] of [
    ["split", (g) => { const b = g.split("card", "x"); return b && g.close(b); }],
    ["splitToward left", (g) => { const b = g.splitToward("card", "left", {}); return b && g.close(b); }],
    ["insertAt 0", (g) => { const b = g.insertAt("x", 0, { size: 190 }); return b && g.close(b); }],
    ["insertAt 1", (g) => { const b = g.insertAt("x", 1, { size: 190 }); return b && g.close(b); }],
    ["insertAt last", (g) => {
      const b = g.insertAt("x", g.lines("x").length - 1, { size: 190 });
      return b && g.close(b);
    }],
  ]) {
    const grid = start();
    const before = widths(grid);
    for (let i = 0; i < 40; i++) {
      assert.ok(round(grid), `${name}: round ${i} completed`);
    }
    assert.deepEqual(widths(grid), before, `${name}: forty rounds changed nothing`);
  }
});

test("R7 — only a fixed card leaves another with nowhere to go", () => {
  // Random operations from a layout with no fixed cards: every open card but
  // the last can always be closed. Add fixed cards and the exception appears.
  const start = (fixed) =>
    new Soksak(
      { xs: [0, 0.16, 0.32, 0.84, 1], ys: [0, 0.5, 1], cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, fixed },
        { id: "rail", c0: 1, c1: 2, r0: 0, r1: 2, fixed },
        { id: "terminal", c0: 2, c1: 3, r0: 0, r1: 1 },
        { id: "browser", c0: 2, c1: 3, r0: 1, r1: 2 },
        { id: "right", c0: 3, c1: 4, r0: 0, r1: 2, fixed },
      ] },
      { width: 1440, height: 900 },
    );

  let stuck = 0;
  for (let seed = 0; seed < 300; seed++) {
    const grid = start(false);
    let rng = seed * 2654435761 + 7;
    const next = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let step = 0; step < 40; step++) {
      const open = grid.cards.filter((c) => !c.fixed);
      if (open.length < 2) break;
      const pick = () => open[Math.floor(next() * open.length)];
      const side = ["left", "right", "top", "bottom"][Math.floor(next() * 4)];
      const roll = next();
      if (roll < 0.35) grid.splitToward(pick().id, side, { data: {} });
      else if (roll < 0.55) grid.close(pick().id);
      else if (roll < 0.8) grid.move(pick().id, pick().id, side);
      else {
        const axis = next() < 0.5 ? "x" : "y";
        const stands = grid.standings(axis);
        if (stands.length) {
          grid.insertAt(axis, stands[Math.floor(next() * stands.length)], { size: 40 + Math.floor(next() * 120) });
        }
      }

      const now = grid.cards.filter((c) => !c.fixed);
      if (now.length < 2) continue;
      for (const c of now) if (!grid.canClose(c.id)) stuck++;
    }
  }
  assert.equal(stuck, 0, "no card is stranded when nothing is fixed");
});

test("R7 — a card whose only filler is fixed stays, and canClose returns false", () => {
  const grid = new Soksak(undefined, { width: 1600, height: 900 });
  const right = grid.split("card", "x");
  const boxed = grid.split("card", "y");
  const below = grid.split(boxed, "y");
  const midR = grid.split(right, "y");
  grid.split(midR, "y");
  grid.setFixed("card", true);
  grid.setFixed(below, true);
  grid.setFixed(midR, true);

  // The exception R7 names: no row of neighbours may grow over it, and its
  // slots hold another card, so removing them is not open either.
  assert.equal(grid.fill(boxed), null, "no row of neighbours can grow over it");
  assert.equal(grid.canClose(boxed), false);
  assert.equal(grid.close(boxed), false, "and it refuses rather than corrupting");
  assert.equal(grid.isSlicing(), true);

  // A fixed card returns false because the layout does not move it. Clearing
  // the flag is what a host does to close one.
  assert.equal(grid.canClose("card"), false, "fixed");
  grid.setFixed("card", false);
  assert.equal(grid.canClose("card"), true);
});

test("a rect is never inside out, whatever the gap", () => {
  for (const gap of [0, 24, 200, 400, 2000]) {
    const grid = new Soksak(undefined, { width: 1000, height: 200, minSize: 0 });
    const b = grid.split("card", "x");
    grid.split(b, "x");
    grid.split("card", "y");
    grid.gap = gap;
    for (const [id, r] of grid.rects()) {
      assert.ok(r.w >= 0 && r.h >= 0, `gap ${gap}: ${id} is ${r.w}x${r.h}`);
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), `gap ${gap}: ${id} at ${r.x},${r.y}`);
    }
  }
});

test("R1 — where a line stands does not depend on which cards read it", () => {
  // A card leaving stops any read of the line it stood on. R5 defines such a
  // line takes no corridor, which is a statement about how wide the cards
  // beside it are drawn — not about where the line is. Answering both from one
  // number slides the line half a corridor onto the edge of the card that grew
  // over it, and the place a person set is lost.
  const grid = new Soksak(
    { xs: [0, 1 / 3, 0.432086, 2 / 3, 1], ys: [0, 0.52, 1], cards: [
      { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 190, fixed: true },
      { id: "rail", c0: 1, c1: 2, r0: 0, r1: 2, width: 280, fixed: true },
      { id: "terminal", c0: 2, c1: 3, r0: 0, r1: 1 },
      { id: "browser", c0: 2, c1: 3, r0: 1, r1: 2 },
      { id: "right", c0: 3, c1: 4, r0: 0, r1: 2, width: 210, fixed: true },
    ] },
    { width: 1950, height: 560, gap: 24 },
  );
  const before = grid.lines("x").map((_, k) => grid.boundaryPos("x", k));
  assert.equal(grid.isVirtual("x", 2), false, "the rail reads the line");

  grid.setFixed("rail", false);
  assert.equal(grid.close("rail"), true);

  assert.equal(grid.isVirtual("x", 2), true, "and now nobody does");
  assert.equal(grid.lines("x").length, before.length, "the line is still there");
  for (let k = 0; k < before.length; k++) {
    assert.ok(
      Math.abs(grid.boundaryPos("x", k) - before[k]) < 1e-6,
      `line ${k} moved from ${before[k]} to ${grid.boundaryPos("x", k)}`,
    );
  }
});

test("a rule reaches into the corridor of the axis it runs along", () => {
  // Eleven columns in 200px: the ten interior lines cannot each hold the 24px
  // gap, so the drawn gap on x is 20 and on y it is the declared 24. A rule that
  // runs along y reaches half of x's gap into the corridor beside it.
  const xs = Array.from({ length: 12 }, (_, i) => i / 11);
  const cards = [{ id: "side", c0: 0, c1: 1, r0: 0, r1: 2 }];
  for (let c = 1; c < 11; c++) {
    cards.push({ id: `t${c}`, c0: c, c1: c + 1, r0: 0, r1: 1 });
    cards.push({ id: `b${c}`, c0: c, c1: c + 1, r0: 1, r1: 2 });
  }
  const grid = new Soksak(
    { xs, ys: [0, 0.5, 1], cards },
    { width: 200, height: 800, gap: 24, minSize: 1 },
  );

  const stretch = grid.rules().find((r) => r.key === "sy:1:1");
  assert.ok(stretch, "the y line has a solid stretch starting at column 1");
  // Half of the drawn gap on x, which is 200 / 10 lines = 20.
  assert.equal(stretch.x, grid.rect("t1").x - 10, "it starts half a drawn x gap before the card");
});
