import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { guillotine } from "./slicing-oracle.mjs";
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
        // A rect is a start and a width, so an end read as their sum carries the
        // one rounding of that addition: the far edge the library computes is
        // one number, and x + w lands within one unit in the last place of it.
        // A start is read as the library computes it and matches exactly.
        if (starts.length > 1) {
          assert.equal(Math.max(...starts) - Math.min(...starts), 0, `seed ${seed}: ${axis}${line} starts in two places`);
        }
        if (ends.length > 1) {
          const end = Math.max(...ends);
          assert.ok(end - Math.min(...ends) <= Number.EPSILON * end, `seed ${seed}: ${axis}${line} ends in two places: ${ends}`);
        }
      }
    }
  }
});

test("R2 — identifiers do not determine layout behavior", { timeout: 10000 }, () => {
  // The tree has no card array, so the order of input cards is no input. What
  // R2 still rests on is the identifier: every call runs once with the
  // identifiers as written and once with each identifier renamed, and the two
  // runs must agree at every step on the lines, the rects and the results.
  const alias = (name) => `renamed-${name}`;
  const unalias = (id) => id.replace(/^renamed-/, "");
  const build = (n) => ({
    root: { cut: "x", kids: [
      { share: 0.18, node: { card: n("left"), fixed: true, width: 180 } },
      { share: 0.18, node: { card: n("rail"), fixed: true, width: 190 } },
      { share: 0.44000000000000006, node: { cut: "y", kids: [
        { share: 0.5, node: { card: n("upper") } },
        { share: 0.5, node: { card: n("lower") } },
      ] } },
      { share: 0.19999999999999996, node: { card: n("right"), fixed: true, width: 200 } },
    ] },
  });
  const operations = [
    (grid, n) => grid.split(n("left"), "x", { id: n("blocked") }),
    (grid, n) => grid.close(n("left")),
    (grid, n) => grid.move(n("left"), n("upper"), "right"),
    (grid, n) => grid.splitToward(n("upper"), "bottom", { id: n("branch"), data: { role: "upper" } }),
    (grid, n) => grid.move(n("branch"), n("lower"), "right"),
    (grid, n) => grid.setSize(n("rail"), "x", 210),
    (grid, n) => grid.moveTo(n("rail"), "x", 4),
    (grid, n) => grid.insertAt("x", 0, { id: n("strip"), size: 80 }),
    (grid, n) => grid.close(n("strip")),
    (grid, n) => grid.moveBoundary("x", 1, 300),
    (grid, n) => grid.close(n("branch")),
    (grid, n) => grid.setFixed(n("upper"), true),
    (grid, n) => grid.close(n("upper")),
    (grid, n) => grid.setFixed(n("upper"), false),
    (grid, n) => grid.resize(240, 150),
    (grid, n) => grid.resize(W, H),
  ];
  const snapshot = (grid) => ({
    lines: { x: grid.lines("x"), y: grid.lines("y") },
    rects: [...grid.rects()].map(([id, r]) => [unalias(id), r]),
    closable: grid.cards.map((c) => [unalias(c.id), grid.canClose(c.id)]),
  });
  const trace = (n) => {
    const grid = new Soksak(build(n), { width: W, height: H });
    const steps = [{ snapshot: snapshot(grid) }];
    for (const operation of operations) {
      const result = operation(grid, n);
      steps.push({ result: typeof result === "string" ? unalias(result) : result, snapshot: snapshot(grid) });
    }
    return steps;
  };
  const plain = trace((name) => name);
  const renamed = trace(alias);
  assert.deepEqual(renamed, plain);
  assert.deepEqual(plain.slice(1, 5).map((s) => s.result), [null, false, false, "branch"]);
  assert.equal(plain[8].result, "strip");
  assert.equal(plain[9].result, true);
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
  grid.split("upper", "x");
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
    const spans = grid.cards.map(({ c0, c1, r0, r1 }) => ({ c0, c1, r0, r1 }));
    assert.ok(guillotine(spans), `seed ${seed}: no cut separates ${JSON.stringify(spans)}`);
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
        { root: { cut: "x", kids: [{ share: 0.25, node: { card: "left", fixed: true, width: 180 } }, { share: 0.25, node: { card: "rail", fixed: true, width: 190 } }, { share: 0.25, node: { cut: "y", kids: [{ share: 0.5, node: { card: "main" } }, { share: 0.5, node: { card: "under" } }] } }, { share: 0.25, node: { card: "right", fixed: true, width: 200 } }] } },
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
  for (const file of ["src/card.ts", "src/tree.ts"]) {
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
  const readme = read("docs/layout.md");
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
    { root: { cut: "y", kids: [{ share: 0.5, node: { cut: "x", kids: [{ share: 0.5, node: { card: "a" } }, { share: 0.5, node: { card: "b" } }] } }, { share: 0.5, node: { card: "under" } }] } },
    { width: 1200, height: 600, gap: 24 },
  );
  rows.close("b");
  assert.deepEqual(rows.lines("x"), [0, 1], "the closed card left its line: no line is left that no card reads");
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

test("a card inserted on an even level and closed leaves the plane as it was", () => {
  // On a level whose kids without a px size are drawn at one size, insertAt
  // takes the new card's size from all of them in proportion, and closing it
  // returns the size to all of them in proportion.
  const start = () => {
    const grid = new Soksak(undefined, { width: 1200, height: 600, gap: 24 });
    grid.split("card", "x");
    return grid;
  };
  const widths = (grid) => grid.cards.map((c) => +grid.rect(c.id).w.toFixed(3));

  for (const [name, round] of [
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

test("a card inserted on an uneven level takes its size from the kid before the boundary alone", () => {
  const grid = new Soksak(
    { root: { cut: "x", kids: [{ share: 0.5, node: { card: "card" } }, { share: 0.25, node: { card: "b" } }, { share: 0.25, node: { card: "c" } }] } },
    { width: 1200, height: 600, gap: 24 },
  );
  const before = new Map(grid.cards.map((c) => [c.id, grid.rect(c.id).w]));
  const first = grid.cards[0].id;
  const added = grid.insertAt("x", 1, { size: 100 });
  assert.ok(added, "the insert went in");
  for (const [id, w] of before) {
    if (id === first) assert.ok(grid.rect(id).w < w - 99, `${id} paid for the new card`);
    else assert.equal(grid.rect(id).w, w, `${id} kept its width`);
  }
});

test("R7 — only a fixed card leaves another with nowhere to go", () => {
  // Random operations from a layout with no fixed cards: every open card but
  // the last can always be closed. Add fixed cards and the exception appears.
  const start = (fixed) =>
    new Soksak(
      { root: { cut: "x", kids: [
        { share: 0.16, node: { card: "left", fixed } },
        { share: 0.16, node: { card: "rail", fixed } },
        { share: 0.52, node: { cut: "y", kids: [
          { share: 0.5, node: { card: "upper" } },
          { share: 0.5, node: { card: "lower" } },
        ] } },
        { share: 0.16, node: { card: "right", fixed } },
      ] } },
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

  // The exception R7 names: every other kid of its cut holds a fixed card, so
  // none of them takes its share.
  assert.equal(grid.canClose(boxed), false);
  assert.equal(grid.close(boxed), false, "and it refuses rather than corrupting");

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
    { root: { cut: "x", kids: [{ share: 0.3333333333333333, node: { card: "left", fixed: true, width: 190 } }, { share: 0.09875266666666671, node: { card: "rail", fixed: true, width: 280 } }, { share: 0.2345806666666666, node: { cut: "y", kids: [{ share: 0.52, node: { card: "upper" } }, { share: 0.48, node: { card: "lower" } }] } }, { share: 0.33333333333333337, node: { card: "right", fixed: true, width: 210 } }] } },
    { width: 1950, height: 560, gap: 24 },
  );
  const before = grid.lines("x").map((_, k) => grid.boundaryPos("x", k));
  const edge = before[1];

  grid.setFixed("rail", false);
  assert.equal(grid.close("rail"), true);

  // The line the rail read at its right edge is gone, since no card reads it
  // any more. Every line that remains stands where it stood.
  const after = grid.lines("x").map((_, k) => grid.boundaryPos("x", k));
  for (const px of after) {
    assert.ok(
      before.some((b) => Math.abs(b - px) < 1e-6),
      `line moved to ${px}, which no line stood at before: [${before}]`,
    );
  }
  assert.ok(
    after.some((px) => Math.abs(px - edge) < 1e-6),
    `the boundary at ${edge} the person set is still there: [${after}]`,
  );
});

test("a rule reaches into the corridor of the axis it runs along", () => {
  // Eleven columns in 200px: the ten interior lines cannot each hold the 24px
  // gap, so the drawn gap on x is 20 and on y it is the declared 24. A rule that
  // runs along y reaches half of x's gap into the corridor beside it.
  const kids = [{ share: 1 / 11, node: { card: "side" } }];
  for (let c = 1; c < 11; c++) {
    kids.push({ share: 1 / 11, node: { cut: "y", kids: [
      { share: 0.5, node: { card: `t${c}` } },
      { share: 0.5, node: { card: `b${c}` } },
    ] } });
  }
  const grid = new Soksak(
    { root: { cut: "x", kids } },
    { width: 200, height: 800, gap: 24, minSize: 1 },
  );

  const stretch = grid.rules().find((r) => r.key === "sy:1:1");
  assert.ok(stretch, "the y line has a solid stretch starting at column 1");
  // Half of the drawn gap on x, which is 200 / 10 lines = 20.
  assert.equal(stretch.x, grid.rect("t1").x - 10, "it starts half a drawn x gap before the card");
});
