import assert from "node:assert/strict";
import test from "node:test";

import { Soksak } from "../dist/index.js";
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

test("edge sets how much of the body each side claims, and a value outside the body is refused", () => {
  const grid = new Soksak(undefined, { width: 1000, height: 400 });
  grid.split("card", "x");
  const body = grid.rect("card");
  const middle = { x: body.x + body.w / 2, y: body.y + body.h / 2 };
  const near = { x: body.x + body.w * 0.3, y: middle.y };

  assert.equal(grid.zoneAt(middle.x, middle.y).zone, "centre", "the middle is the card");
  assert.equal(grid.zoneAt(near.x, near.y).zone, "centre", "and 0.3 across is too, by default");
  assert.equal(grid.zoneAt(near.x, near.y, { edge: 0.4 }).zone, "left", "a wider band takes it");
  // The layout specification gives the range as 0..0.5, so 0.5 is a value and not a refusal:
  // at it the two sides claim the whole body. A refused value falls back to
  // 0.25, which answers centre 0.3 across.
  assert.equal(grid.zoneAt(near.x, near.y, { edge: 0.5 }).zone, "left", "0.5 is the widest band");
  assert.equal(
    grid.zoneAt(near.x, near.y, { edge: 0.5 + 1e-6 }).zone,
    "centre",
    "and past it is refused",
  );

  // Read near the edge, not at the middle. A refused value and an accepted one
  // both answer centre in the middle, so a negative band would pass there.
  const edge = { x: body.x + body.w * 0.05, y: middle.y };
  assert.equal(grid.zoneAt(edge.x, edge.y).zone, "left", "0.05 across is a side by default");
  for (const bad of [NaN, Infinity, -1, 5]) {
    assert.equal(grid.zoneAt(middle.x, middle.y, { edge: bad }).zone, "centre",
      `${bad} is refused in the middle`);
    assert.equal(grid.zoneAt(edge.x, edge.y, { edge: bad }).zone, "left",
      `${bad} is refused at the edge`);
  }

  // The same guard reads the chrome heights. A negative one would start the body
  // outside the card, which moves where the bands begin: at 0.23 down the body
  // the point is in the top band, and it is the centre once the body is taller
  // than the card.
  const high = { x: middle.x, y: body.y + body.h * 0.23 };
  const low = { x: middle.x, y: body.y + body.h * 0.77 };
  assert.equal(grid.zoneAt(high.x, high.y, { headerPx: -40 }).zone, "top",
    "a header of -40 is read as none");
  assert.equal(grid.zoneAt(low.x, low.y, { footerPx: -40 }).zone, "bottom",
    "a footer of -40 is read as none");
});
