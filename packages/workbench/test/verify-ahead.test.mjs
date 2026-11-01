// When verification V7c fails, it names the surface that is off the most and its two places so that the cause can be found (F33).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

test("a failed V7c names the surface and both of its rectangles", async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"><article class="card" data-card-id="one"><div class="chrome"></div><div class="status"></div><div class="slot" data-native-surface data-native-surface-id="probe"></div></article></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  t.after(() => dom.window.close());
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(6, 6, 400, 300);
  document.querySelector(".slot").getBoundingClientRect = () => rect(36, 40, 370, 240);
  // The place and style of a drawn card and the device pixel ratio of the page are the measured values that the failure sentence states (F90).
  const card = document.querySelector(".card");
  card.getBoundingClientRect = () => rect(6, 6, 400, 300);
  card.style.width = "400px";
  card.style.height = "300px";
  globalThis.devicePixelRatio = 1;
  t.after(() => { delete globalThis.devicePixelRatio; });
  const grid = new Soksak(undefined, { width: 400, height: 300 });
  const declared = { x: 0, y: 34, w: 400, h: 240 };
  card.style.setProperty("--pt", "36px");
  const bands = { top: 6, bottom: 0, left: 0, right: 0 };
  const guess = { seq: 12, surfaces: [{ id: "probe", dim: false, declared, applied: declared, bands }] };
  t.mock.module("../compositor.js", { exports: { ahead: () => guess, latest: () => guess, placementPending: () => false, seated: () => null } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => grid, dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane, presentedCardRect: () => undefined,
    railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4 } });
  const { verify } = await import("../verify.js");
  const row = verify().find((item) => item.name.startsWith("V7c "));
  assert.equal(row.ok, false);
  assert.match(row.note, /최대 30\.00px/);
  assert.match(row.note, /probe drawn 30,34 370×240 declared 0,34 400×240 · bands 6\/0\/0\/0 drawn 36px\/0\/0\/0/);
  assert.match(row.note, / · card 0,0 400×300 inset 30,34,0,26 · plane 6,6 400×300 · card style 400px×300px · devicePixelRatio 1$/);
});

/** Runs verify over a plane with one card slot "probe" at its predicted place and the extra slots of html. */
async function verifyAhead(t, extra, guessed) {
  const dom = new JSDOM(`<div class="chrome-bar"></div><div id="stage"><div id="plane"><article class="card" data-card-id="one"><div class="chrome"></div><div class="status"></div><div class="slot" data-native-surface data-native-surface-id="probe"></div></article>${extra}</div></div>`);
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.devicePixelRatio = 1;
  t.after(() => { dom.window.close(); delete globalThis.devicePixelRatio; });
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(0, 0, 400, 300);
  for (const slot of document.querySelectorAll(".slot")) slot.getBoundingClientRect = () => rect(0, 34, 400, 240);
  const declared = { x: 0, y: 34, w: 400, h: 240 };
  const guess = { seq: 7, surfaces: guessed.map((id) => ({ id, dim: false, declared, applied: declared, bands: null })) };
  t.mock.module("../compositor.js", { exports: { ahead: () => guess, latest: () => null, placementPending: () => false, seated: () => null } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => new Soksak(undefined, { width: 400, height: 300 }), dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane,
    presentedCardRect: () => undefined, railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4 } });
  const { verify } = await import(`../verify.js?ahead-${Math.random()}`);
  return verify().find((item) => item.name.startsWith("V7c "));
}

test("V7c compares the predicted card surfaces and does not count a section surface that the drawing added", async (t) => {
  // A section surface is measured after the drawing (docs/spec/native-surfaces.md#section-seats), so the prediction never holds it.
  const row = await verifyAhead(t, '<div class="set__body slot" data-native-surface="view" data-native-surface-id="spc-aaaaaa/left/probe.tree"></div>', ["probe"]);
  assert.equal(row.ok, true, row.note);
});

test("a failed V7c names the drawn card surface that the prediction missed", async (t) => {
  const row = await verifyAhead(t, '<article class="card" data-card-id="two"><div class="chrome"></div><div class="status"></div><div class="slot" data-native-surface data-native-surface-id="tab-late"></div></article>', ["probe"]);
  assert.equal(row.ok, false);
  assert.match(row.note, /누락 1 \[tab-late\]/);
});

test("a failed V7b names the surface and its declared and applied rectangles", async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  t.after(() => dom.window.close());
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(6, 6, 400, 300);
  const grid = new Soksak(undefined, { width: 400, height: 300 });
  // At 2 device pixels per point the host fits the declared rectangle inward to 10,45.5 380×199.5, so the applied height of 200
  // is off by half a point.
  globalThis.devicePixelRatio = 2;
  t.after(() => { delete globalThis.devicePixelRatio; });
  const placed = { seq: 39, settled: true, surfaces: [{ id: "probe", visible: true, dim: false,
    declared: { x: 10, y: 45.25, w: 380, h: 200 }, applied: { x: 10, y: 45.5, w: 380, h: 200 } }] };
  t.mock.module("../compositor.js", { exports: { ahead: () => null, latest: () => null, placementPending: () => false, seated: () => placed } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => grid, dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane, presentedCardRect: () => undefined,
    railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4 } });
  const { verify } = await import("../verify.js?v7b");
  const row = verify().find((item) => item.name.startsWith("V7b "));
  assert.equal(row.ok, false);
  assert.match(row.note, /probe declared 10,45\.25 380×200 applied 10,45\.5 380×200/);
});

test("V7b compares the applied rectangle with the declared rectangle fitted inward to the device pixels", async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  t.after(() => dom.window.close());
  // A display of one device pixel per point cannot show half a point: the host fits a declared height of 580.5 to 580.
  globalThis.devicePixelRatio = 1;
  t.after(() => { delete globalThis.devicePixelRatio; });
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(6, 6, 2400, 700);
  const grid = new Soksak(undefined, { width: 2400, height: 700 });
  const placed = { seq: 9, settled: true, surfaces: [{ id: "probe", visible: true, dim: false,
    declared: { x: 203, y: 33, w: 2120, h: 580.5 }, applied: { x: 203, y: 33, w: 2120, h: 580 } }] };
  t.mock.module("../compositor.js", { exports: { ahead: () => null, latest: () => null, placementPending: () => false, seated: () => placed } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => grid, dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane, presentedCardRect: () => undefined,
    railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  t.mock.module("../registry.js", { exports: { isPlace: () => false } });
  t.mock.module("../settings.js", { exports: { cardRadius: () => 4 } });
  const { verify } = await import("../verify.js?v7b-fitted");
  const row = verify().find((item) => item.name.startsWith("V7b "));
  assert.equal(row.ok, true, row.note);
});
