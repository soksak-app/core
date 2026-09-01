import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
import { assertTiling, H, three, W } from "./helpers.mjs";

const ids = (grid) => grid.panes.map((p) => p.id).sort().join(",");

test("splitToward puts the new pane on the side that was named", () => {
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
      assert.equal(near.x, before.x, `${side}: the pair still starts where the pane did`);
    } else {
      const [near, far] = ahead ? [fresh, kept] : [kept, fresh];
      assert.ok(near.y < far.y, `${side}: the named side is where it landed`);
      assert.equal(near.y, before.y);
    }
    assert.deepEqual(grid.pane(id).data, { mark: side }, `${side}: payload rode along`);
    assertTiling(grid, `after splitToward ${side}`);
  }
});

test("a move takes the pane and its payload to the target's side", () => {
  const grid = three();
  grid.pane("terminal").data = { live: "pty-1" };
  grid.pane("browser").data = { live: "webview-1" };
  grid.split("browser", "y");          // give the layout somewhere to fill from

  const before = ids(grid);
  assert.equal(grid.move("terminal", grid.panes.at(-1).id, "right"), true);

  assert.equal(ids(grid), before, "a move creates and destroys nothing");
  assert.deepEqual(grid.pane("terminal").data, { live: "pty-1" }, "the surface came along");
  assertTiling(grid, "after the move");
});

test("the pane ends up on the side asked for", () => {
  for (const side of ["left", "right", "top", "bottom"]) {
    const grid = three();
    grid.split("browser", "y");
    const target = grid.panes.find((p) => p.id.startsWith("pane-")).id;
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

test("a refused move changes nothing at all", () => {
  const grid = three();
  const before = JSON.stringify(grid.toJSON());

  // the last open pane cannot leave: nothing would fill its space
  const alone = new Soksak(
    { xs: [0, 0.3, 1], ys: [0, 1], panes: [
      { id: "side", c0: 0, c1: 1, r0: 0, r1: 1, fixed: true },
      { id: "only", c0: 1, c1: 2, r0: 0, r1: 1 },
    ] },
    { width: W, height: H },
  );
  assert.equal(alone.move("only", "side", "right"), false);

  assert.equal(grid.move("terminal", "missing", "right"), false, "unknown target");
  assert.equal(grid.move("sidebar", "terminal", "right"), false, "a fixed pane stays");
  assert.equal(grid.move("terminal", "terminal", "right"), false, "beside itself is nothing");
  assert.equal(JSON.stringify(grid.toJSON()), before, "every refusal left the grid untouched");
});

test("canMove answers without moving anything", () => {
  const grid = three();
  grid.split("browser", "y");
  const target = grid.panes.at(-1).id;
  const before = JSON.stringify(grid.toJSON());

  const answer = grid.canMove("terminal", target, "right");
  assert.equal(JSON.stringify(grid.toJSON()), before, "asking is not doing");
  assert.equal(grid.move("terminal", target, "right"), answer, "and the answer was right");
});

test("moving keeps the arrangement slicing, so every pane still closes", () => {
  let rng = 20260902;
  const next = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let seed = 0; seed < 40; seed++) {
    const grid = three();
    for (let i = 0; i < 6; i++) {
      const open = grid.panes.filter((p) => !p.fixed);
      const p = open[Math.floor(next() * open.length)];
      grid.split(p.id, next() < 0.5 ? "x" : "y");
    }
    for (let i = 0; i < 12; i++) {
      const open = grid.panes.filter((p) => !p.fixed);
      const from = open[Math.floor(next() * open.length)];
      const to = open[Math.floor(next() * open.length)];
      const side = ["left", "right", "top", "bottom"][Math.floor(next() * 4)];
      grid.move(from.id, to.id, side);
      assertTiling(grid, `seed ${seed} step ${i}`);
    }
    const open = grid.panes.filter((p) => !p.fixed);
    for (const p of open) {
      if (open.length > 1) assert.equal(grid.canClose(p.id), true, `${p.id} is stuck`);
    }
  }
});
