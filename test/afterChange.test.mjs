import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { H, W } from "./helpers.mjs";

/**
 * Everything that must be true again the moment a structure changes.
 *
 * Each operation is checked on its own elsewhere. This asks the other question:
 * after a removal or a drop has rearranged things, is the arrangement still one
 * every other operation can be run against? A defect that only appears on the
 * *next* action looks like the next action's fault, and is not.
 */
function audit(grid, where) {
  const cards = [...grid.cards];
  const rects = cards.map((c) => grid.rectOf(c));

  // every card is somewhere, with a size
  for (const [i, r] of rects.entries()) {
    for (const v of [r.x, r.y, r.w, r.h]) {
      assert.ok(Number.isFinite(v), `${where}: ${cards[i].id} has a rect of ${JSON.stringify(r)}`);
    }
    assert.ok(r.w > 0 && r.h > 0, `${where}: ${cards[i].id} has no area`);
  }

  // no card refers to a line that is gone, and no span is inverted
  for (const c of cards) {
    assert.ok(c.c0 < c.c1 && c.r0 < c.r1, `${where}: ${c.id} spans nothing`);
    assert.ok(c.c1 <= grid.lines("x").length - 1, `${where}: ${c.id} runs past the last column`);
    assert.ok(c.r1 <= grid.lines("y").length - 1, `${where}: ${c.id} runs past the last row`);
  }

  // ids are unique — a duplicate means one card is standing in for two
  const ids = cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `${where}: two cards share a name`);

  // the plane is covered exactly, with the corridor between neighbours
  const covered = rects.reduce((n, r) => n + (r.w + grid.gap) * (r.h + grid.gap), 0);
  const plane = (grid.width + grid.gap) * (grid.height + grid.gap);
  assert.ok(
    Math.abs(covered - plane) < 2,
    `${where}: coverage off by ${covered - plane}\n  xs=[${grid.lines("x")}] ys=[${grid.lines("y")}]\n  ` +
      cards
        .map((o, i) => `${o.id}[c${o.c0}-${o.c1} r${o.r0}-${o.r1}${o.width !== undefined ? ` w${o.width.toFixed(0)}` : ""}${o.height !== undefined ? ` h${o.height.toFixed(0)}` : ""}] ${rects[i].w.toFixed(0)}x${rects[i].h.toFixed(0)}`)
        .join("  "),
  );

  let closest = Infinity;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      assert.ok(dx > -0.01 || dy > -0.01, `${where}: ${cards[i].id} and ${cards[j].id} overlap`);
      closest = Math.min(closest, Math.max(dx, dy));
    }
  }
  if (rects.length > 1) {
    assert.ok(Math.abs(closest - grid.gap) < 0.5, `${where}: corridor is ${closest}`);
  }

  // and the arrangement is one splitting could have built
  assert.ok(grid.isSlicing(), `${where}: no longer slicing`);

  // Nothing has become impossible. Where every card shares, every open card but
  // the last leaves — `rules.test.mjs` holds that. Once cards hold px sizes the
  // promise narrows and `canClose` owns it, so what is checked here is that the
  // arrangement never deadlocks and that its answer is the truth.
  const open = cards.filter((c) => !c.fixed);
  const layout = () =>
    cards
      .map((o) => `${o.id}[c${o.c0}-${o.c1} r${o.r0}-${o.r1}${o.width !== undefined ? ` w${o.width.toFixed(0)}` : o.height !== undefined ? ` h${o.height.toFixed(0)}` : ""}${o.fixed ? " fixed" : ""}]`)
      .join(" ");
  if (open.length > 1) {
    assert.ok(
      open.some((c) => grid.canClose(c.id)),
      `${where}: not one card can be closed\n  ${layout()}`,
    );
    for (const c of open) {
      const said = grid.canClose(c.id);
      const trial = Soksak.from(grid.toJSON(), { width: grid.width, height: grid.height });
      assert.equal(
        trial.close(c.id),
        said,
        `${where}: canClose(${c.id}) said ${said} and close disagreed\n  ${layout()}`,
      );
    }
  }

  // A px size is what a card gets when the plane can give it. While something
  // is left to share, every one of them is drawn at exactly what it asked for;
  // when nothing is, they scale together — by one multiple, never each on its
  // own — so the plane is still covered exactly.
  for (const axis of ["x", "y"]) {
    const measure = (i) => (axis === "x" ? rects[i].w : rects[i].h);
    const asked = (c) => (axis === "x" ? c.width : c.height);
    const span = (c) => (axis === "x" ? c.c1 - c.c0 : c.r1 - c.r0);
    const holders = cards
      .map((c, i) => [c, i])
      .filter(([c]) => span(c) === 1 && typeof asked(c) === "number" && asked(c) > 0.01);
    if (!holders.length) continue;

    const ratios = holders.map(([c, i]) => measure(i) / asked(c));
    assert.ok(
      Math.max(...ratios) - Math.min(...ratios) < 0.001,
      `${where}: px cards on ${axis} are drawn at different multiples ${ratios.map((r) => r.toFixed(3))}`,
    );

    // Room is a property of slots, not cards: a card with no size of its own can
    // still be standing in a slot some other card holds, and takes that width.
    const lo = (c) => (axis === "x" ? c.c0 : c.r0);
    const held = new Set(holders.map(([c]) => lo(c)));
    const roomLeft = cards.some(
      (c, i) => span(c) === 1 && !held.has(lo(c)) && measure(i) > 0.01,
    );
    if (roomLeft) {
      for (const [c, i] of holders) {
        assert.ok(
          Math.abs(measure(i) - asked(c)) < 0.01,
          `${where}: ${c.id} asked for ${asked(c)} on ${axis} and measures ${measure(i)} with room to spare\n  ` +
            cards.map((o, k) => `${o.id}[c${o.c0}-${o.c1} r${o.r0}-${o.r1}${o.width !== undefined ? ` w${o.width.toFixed(0)}` : ""}${o.height !== undefined ? ` h${o.height.toFixed(0)}` : ""}] ${rects[k].w.toFixed(0)}x${rects[k].h.toFixed(0)}`).join("  "),
        );
      }
    }
  }
}

const start = () =>
  new Soksak(
    {
      xs: [0, 0.18, 0.36, 0.8, 1],
      ys: [0, 0.5, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
        { id: "rail", c0: 1, c1: 2, r0: 0, r1: 2, width: 190, fixed: true },
        { id: "terminal", c0: 2, c1: 3, r0: 0, r1: 1 },
        { id: "browser", c0: 2, c1: 3, r0: 1, r1: 2 },
        { id: "right", c0: 3, c1: 4, r0: 0, r1: 2, width: 200, fixed: true },
      ],
    },
    { width: W, height: H },
  );

test("the arrangement is sound again after every change, whatever the order", () => {
  for (let seed = 0; seed < 250; seed++) {
    const grid = start();
    let rng = seed * 2654435761 + 7;
    const next = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    audit(grid, `seed ${seed} start`);

    for (let step = 0; step < 60; step++) {
      const open = grid.cards.filter((c) => !c.fixed);
      if (!open.length) break;
      const pick = () => open[Math.floor(next() * open.length)];
      const side = ["left", "right", "top", "bottom"][Math.floor(next() * 4)];
      const roll = next();
      let what = "";

      if (roll < 0.3) {
        what = `split ${side}`;
        grid.splitToward(pick().id, side, { data: { n: step } });
      } else if (roll < 0.5) {
        const c = pick();
        what = `close ${c.id}`;
        grid.close(c.id);
      } else if (roll < 0.75) {
        const from = pick();
        const to = pick();
        what = `move ${from.id} ${side} of ${to.id}`;
        grid.move(from.id, to.id, side);
      } else if (roll < 0.8) {
        // `insertAt` was reachable from the host and from no test, so the audit
        // never walked the path where a card stands in a slot of its own.
        const axis = next() < 0.5 ? "x" : "y";
        const stands = grid.standings(axis);
        if (stands.length) {
          const line = stands[Math.floor(next() * stands.length)];
          what = `insert at ${axis}${line}`;
          grid.insertAt(axis, line, { size: 40 + Math.floor(next() * 120) });
        }
      } else if (roll < 0.88) {
        const stands = grid.standings("x");
        if (stands.length) {
          const line = stands[Math.floor(next() * stands.length)];
          what = `rail to ${line}`;
          grid.moveTo("rail", "x", line);
        }
      } else {
        const dividers = grid.dividers();
        if (dividers.length) {
          const d = dividers[Math.floor(next() * dividers.length)];
          what = `drag ${d.axis}${d.line}`;
          grid.moveBoundary(d.axis, d.line, grid.boundaryPos(d.axis, d.line) + (next() - 0.5) * 300);
        }
      }
      audit(grid, `seed ${seed} step ${step} after ${what}`);
    }
  }
});

test("a fixed card is never moved, closed, or resized by someone else's change", () => {
  for (let seed = 0; seed < 40; seed++) {
    const grid = start();
    let rng = seed * 7919 + 3;
    const next = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const widths = { left: 180, right: 200 };

    for (let step = 0; step < 25; step++) {
      const open = grid.cards.filter((c) => !c.fixed);
      if (!open.length) break;
      const c = open[Math.floor(next() * open.length)];
      const side = ["left", "right", "top", "bottom"][Math.floor(next() * 4)];
      if (next() < 0.5) grid.splitToward(c.id, side, { data: {} });
      else if (next() < 0.6) grid.close(c.id);
      else grid.move(c.id, open[Math.floor(next() * open.length)].id, side);

      for (const [id, want] of Object.entries(widths)) {
        const card = grid.card(id);
        assert.ok(card, `seed ${seed} step ${step}: ${id} was removed`);
        assert.equal(card.width, want, `seed ${seed} step ${step}: ${id} was resized`);
        assert.equal(card.fixed, true, `seed ${seed} step ${step}: ${id} stopped being fixed`);
      }
    }
  }
});
