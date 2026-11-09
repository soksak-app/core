// V7c and V7b at a display of 3 device pixels per point (scale 2 × frame factor 1.5), where the plane puts a card on thirds of
// a point and the layout of the page measures its edges in 1/64 of a point (F715-2).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

/** Runs verify over a plane at 7,83 with one card whose surface "probe" was predicted and seated at declared. */
async function verifyThirds(t, declared, applied) {
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
  document.querySelector(".slot").getBoundingClientRect = () => rect(210, 470.328125, 760, 259.65625);
  const guess = { seq: 40, surfaces: [{ id: "probe", dim: false, declared, applied: declared, bands: null }] };
  const placed = { seq: 40, settled: true, surfaces: [{ id: "probe", visible: true, dim: false, declared, applied }] };
  t.mock.module("../compositor.js", { exports: { ahead: () => guess, latest: () => null, placementPending: () => false, seated: () => placed } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => new Soksak(undefined, { width: 1186, height: 670 }), dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane,
    presentedCardRect: () => undefined, railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4 } });
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

test("V7c names a surface drawn one device pixel lower than its prediction", async (t) => {
  const { v7c } = await verifyThirds(t, { ...thirds, y: thirds.y - 1 / 3 }, { x: 203, y: 1161 / 3, w: 760, h: (1940 - 1161) / 3 });
  assert.equal(v7c.ok, false);
  assert.match(v7c.note, /probe drawn 203,387\.33 760×259\.66 declared 203,387 760×259\.67/);
});
