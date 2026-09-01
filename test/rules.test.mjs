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
