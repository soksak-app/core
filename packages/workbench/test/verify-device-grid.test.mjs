// V7c and V7b at a display of 3 device pixels per point (scale 2 × frame factor 1.5), where the plane puts a card on thirds of
// a point and the layout of the page measures its edges in 1/64 of a point (F715-2).
// The plane, the compositor and the host module are the modules of the page; the host answers each preparation with the page-wire case
// of the test (docs/spec/cases/page-wire/README.md). The test of a seated surface without a seat scale is the one that keeps replaced modules.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";
import { selectPageWire } from "@soksak/runtime";
import { openVerifyPlane, rect } from "./support/verify-plane.mjs";

// The host module reads the wire when it is imported, so the case of the first test is selected before the page opens.
const firstWire = selectPageWire("verify-device-grid-v7c-thirds");
const page = await openVerifyPlane();
after(() => page.close());
const { compositor, verify } = page;

// The card of the plane at 202,354.333 762×315.667 with the insets 1,33,1,23 of its surface.
const CARD = { x: 202, y: 354 + 1 / 3, w: 762, h: 315 + 2 / 3 };
const INSET = { left: 1, top: 33, width: 2, height: 56 };

/**
 * Runs verify over a plane at 7,83 with one card whose surface "probe" was predicted from card and inset on the grid of grid, and
 * seated by the host with the answer of the case of wire. The drawn slot is slot, the rectangle that the layout measures.
 */
async function verifyThirds(wire, { card = CARD, inset = INSET, grid = 3, slot = rect(210, 470.328125, 760, 259.65625) } = {}) {
  globalThis.devicePixelRatio = 3;
  page.measure(page.planeEl, rect(7, 83, 1186, 670));
  // The card of the plane is at 202,354.333 762×315.667. The layout measures it on 1/64 of a point: its top 437.333 reads
  // 437.328125 and its height 315.65625, and the surface inside it reads 470.328125 and 259.65625. Both edges lie on the same
  // device pixel of the display as those of the plane.
  page.measure(page.card, rect(209, 437.328125, 762, 315.65625));
  page.card.style.width = "762px";
  page.card.style.height = "315.666667px";
  page.measure(page.slot, slot);
  page.mark();
  const cardId = page.card.dataset.cardId;
  try {
    await compositor.publishAhead(new Map([[cardId, card]]), new Map([[cardId, { id: "probe", dim: false, inset, grid }]]), 40);
    const rows = verify();
    return { v7c: rows.find((item) => item.name.startsWith("V7c ")), v7b: rows.find((item) => item.name.startsWith("V7b ")) };
  } finally {
    page.reset();
    wire.finish();
  }
}

test("V7c accepts a surface drawn on 1/64 of a point that covers the device pixels of its prediction", { timeout: 5000 }, async () => {
  const { v7c } = await verifyThirds(firstWire);
  assert.equal(v7c.ok, true, v7c.note);
});

test("V7b accepts the applied rectangle of a prediction on thirds of a point", { timeout: 5000 }, async () => {
  const { v7b } = await verifyThirds(selectPageWire("verify-device-grid-v7b-thirds"));
  assert.equal(v7b.ok, true, v7b.note);
});

// The card and the inset of a prediction at 203,553.66 1360×413.33.
const TALL = { card: { x: 0, y: 0, w: 1600, h: 1100 }, inset: { left: 203, top: 553.66, width: 240, height: 686.67 } };

test("V7b compares the applied rectangle with its declared one in whole device pixels", { timeout: 5000 }, async () => {
  // The host fits the declared rectangle of the tauriv2 run in window coordinates, 83 points below the plane, and answers it in plane
  // coordinates: the same device pixels, whose height reads 413.0000000000001 instead of 413 after the subtraction.
  const wire = selectPageWire("verify-device-grid-v7b-remainder");
  const { v7b } = await verifyThirds(wire, TALL);
  assert.notEqual(compositor.seated().surfaces[0].applied.h, 413, "the applied height carries the remainder of the window coordinates");
  assert.equal(v7b.ok, true, v7b.note);
});

test("V7b names an applied rectangle one device pixel off its declared one", { timeout: 5000 }, async () => {
  const { v7b } = await verifyThirds(selectPageWire("verify-device-grid-v7b-one-pixel"), TALL);
  assert.equal(v7b.ok, false);
  assert.match(v7b.note, /차이 0\.33px/);
});

test("V7b judges an applied rectangle on the grid of the scale that seated it and names a seat of another display", { timeout: 5000 }, async () => {
  // The host seated the declared rectangle on the device pixels of a display of scale 2, and the window now shows the page at 3:
  // on its own grid the seat is exact, and it is off the grid of the display that shows it until the next placement.
  const { v7b } = await verifyThirds(selectPageWire("verify-device-grid-v7b-other-scale"), TALL);
  assert.equal(v7b.ok, false);
  assert.match(v7b.note, /차이 0\.00px/);
  assert.match(v7b.note, /다른 scale 에 놓인 표면 1 \(probe seated at 2, display 3\)/);
});

// The compositor answers a visible surface of the host only with the scale that the host named (validatePlacementAnswer), so no
// placement of the page seats a visible surface without a scale. Verification refuses such a record with its own error, and the record can
// be given to verification only through a compositor that answers it, so this test keeps the replaced compositor and plane.
test("V7b refuses a seated surface without the scale that seated it", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"><article class="card" data-card-id="one"><div class="chrome"></div><div class="status"></div><div class="slot" data-native-surface data-native-surface-id="probe"></div></article></div></div>');
  const held = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, devicePixelRatio: globalThis.devicePixelRatio };
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.devicePixelRatio = 3;
  t.after(() => {
    globalThis.document = held.document;
    globalThis.getComputedStyle = held.getComputedStyle;
    globalThis.devicePixelRatio = held.devicePixelRatio;
    dom.window.close();
  });
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(7, 83, 1186, 670);
  const declared = { x: 203, y: 354 + 1 / 3 + 33, w: 760, h: 315 + 2 / 3 - 56 };
  const placed = { seq: 40, settled: true, surfaces: [{ id: "probe", visible: true, dim: false, declared, applied: declared }] };
  t.mock.module("../compositor.js", { exports: { ahead: () => null, latest: () => null, placementPending: () => false, seated: () => placed } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => new Soksak(undefined, { width: 1186, height: 670 }), dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane,
    presentedCardRect: () => undefined, railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  const { verify: replaced } = await import("../verify.js?unscaled");
  assert.throws(() => replaced(), /verify: seated surface probe has no seat scale/);
});

test("V7c names a surface drawn one device pixel lower than its prediction", { timeout: 5000 }, async () => {
  const { v7c } = await verifyThirds(selectPageWire("verify-device-grid-v7c-lower"), { card: { ...CARD, y: 354 } });
  assert.equal(v7c.ok, false);
  assert.match(v7c.note, /probe drawn 203,387\.33 760×259\.66 declared 203,387 760×259\.67/);
});

test("V7c judges a prediction on the grid that its layout was made on when the display changed scale before the check", { timeout: 5000 }, async () => {
  // The tauriv2 run: the plane laid the card out at 202,0 762×342.5 on the device pixels of scale 2 and drew its surface at that
  // prediction, and the window showed the page at 3 before the check. On the grid of scale 3 the bottom edge 319.5 lies between two
  // device pixels, so the inward fit and the paint of the same rectangle part by a device pixel, though nothing moved.
  const { v7c } = await verifyThirds(selectPageWire("verify-device-grid-v7c-before-display"),
    { card: { x: 202, y: 0, w: 762, h: 342.5 }, grid: 2, slot: rect(210, 116, 760, 286.5) });
  assert.equal(v7c.ok, true, v7c.note);
});

test("V7c refuses a predicted surface without the grid that its layout was made on", { timeout: 5000 }, async () => {
  await assert.rejects(verifyThirds(selectPageWire("verify-device-grid-v7c-no-grid"), { grid: null }), /verify: predicted surface probe has no grid scale/);
});
