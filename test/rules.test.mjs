import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { H, W, fuzz, three } from "./helpers.mjs";

/**
 * One test per rule in the README.
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
        const crossing = grid.cardsCrossing(axis, line);
        assert.equal(
          grid.canInsertAt(axis, line),
          crossing.length === 0,
          `seed ${seed}: ${axis}${line} disagrees with its own spans`,
        );
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

test("R4 — nothing reachable is outside what splitting could build", () => {
  for (let seed = 0; seed < 60; seed++) {
    const grid = three();
    fuzz(grid, seed, 60);
    assert.ok(grid.isSlicing(), `seed ${seed}`);
  }
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

test("every rule the README states has a test that names it", () => {
  const readme = read("README.md");
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
  const born = grid.insertAt("x", 1, { id: "rail", size: 190 });
  grid.close(born);
  const remembered = grid
    .lines("x")
    .some((_, i) => i > 0 && i < grid.lines("x").length - 1 && grid.isVirtual("x", i));
  assert.ok(remembered, "the boundary is remembered");
  assert.equal(
    grid.cards.reduce((n, c) => n + grid.rect(c.id).w, 0) + grid.gap,
    grid.width,
    "and the plane is still spent on cards and one corridor, not on the memory",
  );

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

test("RED — putting a place up and taking it down leaves the plane as it was", () => {
  // `insertAt` takes the room it needs from everyone in proportion. `close`
  // hands it back to one neighbour — the one that grows to cover the rectangle.
  // So the two are not inverses: 588/588 becomes 493/683, then 413/763, and by
  // the ninth round trip no rail will fit.
  //
  // Making the close give the room back is one line — fold the vacated slot to
  // nothing and renormalise — and it works: twenty round trips leave 588/588
  // exactly. But a slot folded to nothing puts its line on top of its
  // neighbour, and that line was the memory of where the boundary had been, so
  // a later split can no longer land on it. `lines.test.mjs` holds that memory
  // to be a rule too.
  //
  // The two cannot both hold: returning the room needs the slot to go to zero,
  // remembering the position needs it to keep its width. Which rule wins is a
  // decision, not a defect, and this stays RED until that decision is made.
  const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24 });
  grid.split("card", "x");
  const before = grid.cards.map((c) => +grid.rect(c.id).w.toFixed(3));

  for (let i = 0; i < 12; i++) {
    const born = grid.insertAt("x", 1, { id: `rail-${i}`, size: 190 });
    assert.ok(born, `round ${i}: a rail could still be put up`);
    assert.equal(grid.close(born), true, `round ${i}: and taken down`);
  }

  assert.deepEqual(
    grid.cards.map((c) => +grid.rect(c.id).w.toFixed(3)),
    before,
    "twelve round trips left the panes exactly as they were",
  );
});
