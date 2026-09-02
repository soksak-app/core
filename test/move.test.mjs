import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, three, W } from "./helpers.mjs";

const ids = (grid) => grid.cards.map((p) => p.id).sort().join(",");

test("splitToward puts the new card on the side that was named", () => {
  for (const [side, ahead] of [["right", false], ["left", true], ["bottom", false], ["top", true]]) {
    const grid = three();
    const before = grid.rect("terminal");
    const id = grid.splitToward("terminal", side, { data: { mark: side } });
    assert.ok(id, side);
    const fresh = grid.rect(id);
    const kept = grid.rect("terminal");

    if (side === "left" || side === "right") {
      const [near, far] = ahead ? [fresh, kept] : [kept, fresh];
      assert.ok(near.x < far.x, `${side}: the named side is where it landed`);
      assert.equal(near.x, before.x, `${side}: the pair still starts where the card did`);
    } else {
      const [near, far] = ahead ? [fresh, kept] : [kept, fresh];
      assert.ok(near.y < far.y, `${side}: the named side is where it landed`);
      assert.equal(near.y, before.y);
    }
    assert.deepEqual(grid.card(id).data, { mark: side }, `${side}: payload rode along`);
    assertTiling(grid, `after splitToward ${side}`);
  }
});

test("move takes the card and its data to the target side", () => {
  const grid = three();
  grid.setData("terminal", { live: "pty-1" });
  grid.setData("browser", { live: "webview-1" });
  grid.split("browser", "y");          // give the layout somewhere to fill from

  const before = ids(grid);
  assert.equal(grid.move("terminal", grid.cards.at(-1).id, "right"), true);

  assert.equal(ids(grid), before, "a move creates and destroys nothing");
  assert.deepEqual(grid.card("terminal").data, { live: "pty-1" }, "the surface came along");
  assertTiling(grid, "after the move");
});

test("move places the card on the named side", () => {
  for (const side of ["left", "right", "top", "bottom"]) {
    const grid = three();
    grid.split("browser", "y");
    const target = grid.cards.find((p) => p.id.startsWith("card-")).id;
    if (!grid.canMove("terminal", target, side)) continue;

    assert.equal(grid.move("terminal", target, side), true, side);
    const moved = grid.rect("terminal");
    const t = grid.rect(target);
    if (side === "left") assert.ok(moved.x < t.x, side);
    if (side === "right") assert.ok(moved.x > t.x, side);
    if (side === "top") assert.ok(moved.y < t.y, side);
    if (side === "bottom") assert.ok(moved.y > t.y, side);
    assertTiling(grid, `after moving ${side}`);
  }
});

test("a refused move changes nothing", () => {
  const grid = three();
  const before = JSON.stringify(grid.toJSON());

  // the last open card cannot leave: nothing would fill its space
  const alone = new Soksak(
    { xs: [0, 0.3, 1], ys: [0, 1], cards: [
      { id: "side", c0: 0, c1: 1, r0: 0, r1: 1, fixed: true },
      { id: "only", c0: 1, c1: 2, r0: 0, r1: 1 },
    ] },
    { width: W, height: H },
  );
  assert.equal(alone.move("only", "side", "right"), false);

  assert.equal(grid.move("terminal", "missing", "right"), false, "unknown target");
  assert.equal(grid.move("sidebar", "terminal", "right"), false, "a fixed card stays");
  assert.equal(grid.move("terminal", "terminal", "right"), false, "beside itself is nothing");
  assert.equal(JSON.stringify(grid.toJSON()), before, "every refusal left the grid untouched");
});

test("canMove does not change the state", () => {
  const grid = three();
  grid.split("browser", "y");
  const target = grid.cards.at(-1).id;
  const before = JSON.stringify(grid.toJSON());

  const answer = grid.canMove("terminal", target, "right");
  assert.equal(JSON.stringify(grid.toJSON()), before, "asking is not doing");
  assert.equal(grid.move("terminal", target, "right"), answer, "and the answer was right");
});

test("moving leaves a slicing arrangement", () => {
  let rng = 20260902;
  const next = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let seed = 0; seed < 40; seed++) {
    const grid = three();
    for (let i = 0; i < 6; i++) {
      const open = grid.cards.filter((p) => !p.fixed);
      const p = open[Math.floor(next() * open.length)];
      grid.split(p.id, next() < 0.5 ? "x" : "y");
    }
    for (let i = 0; i < 12; i++) {
      const open = grid.cards.filter((p) => !p.fixed);
      const from = open[Math.floor(next() * open.length)];
      const to = open[Math.floor(next() * open.length)];
      const side = ["left", "right", "top", "bottom"][Math.floor(next() * 4)];
      grid.move(from.id, to.id, side);
      assertTiling(grid, `seed ${seed} step ${i}`);
    }
    const open = grid.cards.filter((p) => !p.fixed);
    for (const p of open) {
      if (open.length > 1) assert.equal(grid.canClose(p.id), true, `${p.id} is stuck`);
    }
  }
});

test("a split does not change which card holds which id", () => {
  const grid = three();
  grid.setData("terminal", { live: "pty-1" });

  const born = grid.splitToward("terminal", "left", { data: { live: "pty-2" } });
  // A host holds ids, so a split must not swap which card carries which id.
  assert.equal(grid.card("terminal").id, "terminal", "its name did not change underneath");
  assert.deepEqual(grid.card("terminal").data, { live: "pty-1" }, "nor did what it holds");
  assert.deepEqual(grid.card(born).data, { live: "pty-2" });

  // left means left: the new card is the one nearer the start
  assert.ok(grid.rect(born).x < grid.rect("terminal").x);
  assertTiling(grid, "after splitting toward the left");
});

test("no existing id is reassigned", () => {
  const grid = three();
  const seen = new Map(grid.cards.map((c) => [c, c.id]));
  grid.splitToward("terminal", "top", { data: {} });
  grid.splitToward("browser", "left", { data: {} });
  for (const [card, id] of seen) {
    assert.equal(card.id, id, `${id} was renamed under the host`);
  }
});
