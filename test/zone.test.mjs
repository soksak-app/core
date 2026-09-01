import assert from "node:assert/strict";
import test from "node:test";

import { H, W, three } from "./helpers.mjs";

const HEADER = 34;
const FOOTER = 24;

/** The middle of a card, and a point a fraction of the way toward one of its edges. */
const at = (grid, id, fx, fy) => {
  const r = grid.rect(id);
  const top = r.y + HEADER;
  const bottom = r.y + r.h - FOOTER;
  return [r.x + r.w * fx, top + (bottom - top) * fy];
};
const zone = (grid, id, fx, fy, options = {}) =>
  grid.zoneAt(...at(grid, id, fx, fy), { headerPx: HEADER, footerPx: FOOTER, ...options });

test("the middle of a card is the card itself", () => {
  const grid = three();
  assert.deepEqual(zone(grid, "terminal", 0.5, 0.5), { id: "terminal", zone: "centre" });
});

test("near an edge is the side nearest the point", () => {
  const grid = three();
  for (const [fx, fy, side] of [
    [0.05, 0.5, "left"],
    [0.95, 0.5, "right"],
    [0.5, 0.05, "top"],
    [0.5, 0.95, "bottom"],
  ]) {
    assert.deepEqual(zone(grid, "terminal", fx, fy), { id: "terminal", zone: side }, side);
  }
});

test("chrome is never a side — a header is not the top of the body", () => {
  const grid = three();
  const r = grid.rect("terminal");
  assert.deepEqual(
    grid.zoneAt(r.x + r.w / 2, r.y + HEADER / 2, { headerPx: HEADER, footerPx: FOOTER }),
    { id: "terminal", zone: "centre" },
    "over the header",
  );
  assert.deepEqual(
    grid.zoneAt(r.x + r.w / 2, r.y + r.h - FOOTER / 2, { headerPx: HEADER, footerPx: FOOTER }),
    { id: "terminal", zone: "centre" },
    "over the status bar",
  );
});

test("the band is a fraction, so a small card aims like a large one", () => {
  const grid = three();
  grid.split("terminal", "x");
  const small = grid.cards.find((c) => c.id.startsWith("card-")).id;
  assert.deepEqual(zone(grid, small, 0.05, 0.5), { id: small, zone: "left" });
  assert.deepEqual(zone(grid, small, 0.5, 0.5), { id: small, zone: "centre" });
});

test("a card dragged onto itself only ever returns centre", () => {
  const grid = three();
  assert.deepEqual(
    zone(grid, "terminal", 0.05, 0.5, { centreOnly: "terminal" }),
    { id: "terminal", zone: "centre" },
    "there is no side of itself to land on",
  );
  assert.deepEqual(zone(grid, "browser", 0.05, 0.5, { centreOnly: "terminal" }), {
    id: "browser",
    zone: "left",
  });
});

test("a point outside every card lands nowhere", () => {
  const grid = three();
  assert.equal(grid.zoneAt(-10, -10), null);
  assert.equal(grid.zoneAt(W + 10, H + 10), null);
  // the corridor between two cards is in neither card
  const left = grid.rect("sidebar");
  assert.equal(grid.zoneAt(left.x + left.w + grid.gap / 2, left.y + 40), null);
});

test("every card returns a zone for its own area only", () => {
  const grid = three();
  grid.split("terminal", "x");
  grid.split("browser", "y");
  for (const card of grid.cards) {
    const hit = zone(grid, card.id, 0.5, 0.5);
    assert.equal(hit?.id, card.id, `${card.id} answered for its own middle`);
  }
});
