// V7c and V7b at a display of 3 device pixels per point (scale 2 × frame factor 1.5), where the plane puts a card on thirds of
// a point and the layout of the page measures its edges in 1/64 of a point (F715-2).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

/**
 * Runs verify over a plane at 7,83 with one card whose surface "probe" was predicted at declared on the grid of laid and seated by
 * the host at applied on the device pixels of seat, or without either scale for null. slot is the drawn rectangle of the surface.
 */
async function verifyThirds(t, declared, applied, seat = 3, laid = 3, slot = rect(210, 470.328125, 760, 259.65625)) {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"><article class="card" data-card-id="one"><div class="chrome"></div><div class="status"></div><div class="slot" data-native-surface data-native-surface-id="probe"></div></article></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.devicePixelRatio = 3;
  t.after(() => { dom.window.close(); delete globalThis.devicePixelRatio; });
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(7, 83, 1186, 670);
  // The card of the plane is at 202,354.333 762×315.667. The layout measures it on 1/64 of a point: its top 437.333 reads
  // 437.328125 and its height 315.65625, and the surface inside it reads 470.328125 and 259.65625. Both edges lie on the same
  // device pixel of the display as those of the plane.
  const card = document.querySelector(".card");
  card.getBoundingClientRect = () => rect(209, 437.328125, 762, 315.65625);
  card.style.width = "762px";
  card.style.height = "315.666667px";
  document.querySelector(".slot").getBoundingClientRect = () => slot;
  const guess = { seq: 40, surfaces: [{ id: "probe", dim: false, declared, applied: declared, bands: null, ...(laid === null ? {} : { grid: laid }) }] };
  const placed = { seq: 40, settled: true, surfaces: [{ id: "probe", visible: true, dim: false, declared, applied, ...(seat === null ? {} : { scale: seat }) }] };
  t.mock.module("../compositor.js", { exports: { ahead: () => guess, latest: () => null, placementPending: () => false, seated: () => placed } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => new Soksak(undefined, { width: 1186, height: 670 }), dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane,
    presentedCardRect: () => undefined, railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4, value: (key) => (key === "sidebarOrder" ? ["left", "right", "top", "bottom"] : undefined) } });
  const { verify } = await import(`../verify.js?thirds-${Math.random()}`);
  const rows = verify();
  return { v7c: rows.find((item) => item.name.startsWith("V7c ")), v7b: rows.find((item) => item.name.startsWith("V7b ")) };
}

// The prediction of the card at 202,354.333 762×315.667 with the insets 1,33,1,23 of its surface.
const thirds = { x: 203, y: 354 + 1 / 3 + 33, w: 760, h: 315 + 2 / 3 - 56 };

test("V7c accepts a surface drawn on 1/64 of a point that covers the device pixels of its prediction", async (t) => {
  const { v7c } = await verifyThirds(t, thirds, { x: 203, y: 1162 / 3, w: 760, h: (1941 - 1162) / 3 });
  assert.equal(v7c.ok, true, v7c.note);
});

test("V7b accepts the applied rectangle of a prediction on thirds of a point", async (t) => {
  const { v7b } = await verifyThirds(t, thirds, { x: 203, y: 1162 / 3, w: 760, h: (1941 - 1162) / 3 });
  assert.equal(v7b.ok, true, v7b.note);
});

test("V7b compares the applied rectangle with its declared one in whole device pixels", async (t) => {
  // The host fits the declared rectangle of the tauriv2 run in window coordinates, 83 points below the plane, and answers it in plane
  // coordinates: the same device pixels, whose height reads 413.0000000000001 instead of 413 after the subtraction.
  const declared = { x: 203, y: 553.66, w: 1360, h: 413.33 };
  const top = Math.ceil((83 + declared.y) * 3) / 3;
  const bottom = Math.floor((83 + declared.y + declared.h) * 3) / 3;
  const applied = { x: 203, y: top - 83, w: 1360, h: bottom - top };
  assert.notEqual(applied.h, 413, "the applied height carries the remainder of the window coordinates");
  const { v7b } = await verifyThirds(t, declared, applied);
  assert.equal(v7b.ok, true, v7b.note);
});

test("V7b names an applied rectangle one device pixel off its declared one", async (t) => {
  const declared = { x: 203, y: 553.66, w: 1360, h: 413.33 };
  const { v7b } = await verifyThirds(t, declared, { x: 203, y: 1662 / 3, w: 1360, h: 413 - 1 / 3 });
  assert.equal(v7b.ok, false);
  assert.match(v7b.note, /차이 0\.33px/);
});

test("V7b judges an applied rectangle on the grid of the scale that seated it and names a seat of another display", async (t) => {
  // The host seated the declared rectangle on the device pixels of a display of scale 2, and the window now shows the page at 3:
  // on its own grid the seat is exact, and it is off the grid of the display that shows it until the next placement.
  const declared = { x: 203, y: 553.66, w: 1360, h: 413.33 };
  const top = Math.ceil((83 + declared.y) * 2) / 2;
  const bottom = Math.floor((83 + declared.y + declared.h) * 2) / 2;
  const applied = { x: 203, y: top - 83, w: 1360, h: bottom - top };
  const { v7b } = await verifyThirds(t, declared, applied, 2);
  assert.equal(v7b.ok, false);
  assert.match(v7b.note, /차이 0\.00px/);
  assert.match(v7b.note, /다른 scale 에 놓인 표면 1 \(probe seated at 2, display 3\)/);
});

test("V7b refuses a seated surface without the scale that seated it", async (t) => {
  await assert.rejects(verifyThirds(t, thirds, thirds, null), /verify: seated surface probe has no seat scale/);
});

test("V7c names a surface drawn one device pixel lower than its prediction", async (t) => {
  const { v7c } = await verifyThirds(t, { ...thirds, y: thirds.y - 1 / 3 }, { x: 203, y: 1161 / 3, w: 760, h: (1940 - 1161) / 3 });
  assert.equal(v7c.ok, false);
  assert.match(v7c.note, /probe drawn 203,387\.33 760×259\.66 declared 203,387 760×259\.67/);
});

test("V7c judges a prediction on the grid that its layout was made on when the display changed scale before the check", async (t) => {
  // The tauriv2 run: the plane laid the card out at 202,0 762×342.5 on the device pixels of scale 2 and drew its surface at that
  // prediction, and the window showed the page at 3 before the check. On the grid of scale 3 the bottom edge 319.5 lies between two
  // device pixels, so the inward fit and the paint of the same rectangle part by a device pixel, though nothing moved.
  const declared = { x: 203, y: 33, w: 760, h: 286.5 };
  const applied = { x: 203, y: 33, w: 760, h: 286 + 1 / 3 };
  const { v7c } = await verifyThirds(t, declared, applied, 3, 2, rect(210, 116, 760, 286.5));
  assert.equal(v7c.ok, true, v7c.note);
});

test("V7c refuses a predicted surface without the grid that its layout was made on", async (t) => {
  await assert.rejects(verifyThirds(t, thirds, thirds, 3, null), /verify: predicted surface probe has no grid scale/);
});
