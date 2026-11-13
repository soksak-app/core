// V7a compares the place of each declared surface that has a presented area with its drawn slot. An invisible declaration with
// zero width or zero height has no presented area and so no place to compare (Verification in docs/spec/surface-composition.md).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Soksak } from "soksak";

const rect = (x, y, w, h) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h });

/** The V7a row of a plane whose one card draws its slot at 1,1 with the size w×h, against the latest commit holding declared. */
function v7a(t, slot, surface) {
  return v7aOf(t, slot, { seq: 10, deferred: [], surfaces: [{ id: "probe", dim: false, scale: 2, ...surface, applied: surface.declared }] });
}

/** The V7a row of the same plane against the latest commit record. */
async function v7aOf(t, slot, record) {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"><article class="card" data-card-id="one"><div class="chrome"></div><div class="status"></div><div class="slot" data-native-surface data-native-surface-id="probe"></div></article></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.devicePixelRatio = 2;
  t.after(() => { delete globalThis.devicePixelRatio; dom.window.close(); });
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(0, 0, 400, 300);
  document.querySelector(".card").getBoundingClientRect = () => rect(0, 0, slot.w + 2, slot.h + 2);
  document.querySelector(".slot").getBoundingClientRect = () => rect(1, 1, slot.w, slot.h);
  const grid = new Soksak(undefined, { width: 400, height: 300 });
  t.mock.module("../compositor.js", { exports: { ahead: () => null, latest: () => record, placementPending: () => false, seated: () => record } });
  t.mock.module("../plane.js", { exports: {
    currentGrid: () => grid, dropBands: () => ({ headerPx: 32, footerPx: 22 }), plane, presentedCardRect: () => undefined,
    railOutline: () => ({ shape: { sharp: 0, corners: 0, loops: [] }, rects: [], groups: [] }), tabsOf: () => [],
  } });
  const { verify } = await import(`../verify.js?empty-${Math.random()}`);
  return verify().find((row) => row.name.startsWith("V7a "));
}

test("an invisible declaration without an area passes V7a wherever its empty slot stands", async (t) => {
  const row = await v7a(t, { w: 0, h: 0 }, { visible: false, declared: { x: 0, y: 0, w: 0, h: 0 } });
  assert.equal(row.ok, true, row.note);
});

test("a declaration with an area that is one point off its slot fails V7a", async (t) => {
  const row = await v7a(t, { w: 10, h: 10 }, { visible: true, declared: { x: 0, y: 0, w: 10, h: 10 } });
  assert.equal(row.ok, false);
  assert.match(row.note, /최대 1\.00px/);
});

test("a drawn slot of a view that its placement deferred is in the commit as deferred and V7a names it", async (t) => {
  const row = await v7aOf(t, { w: 10, h: 10 }, { seq: 10, deferred: ["probe"], surfaces: [] });
  assert.equal(row.ok, true, row.note);
  assert.match(row.note, /미룬 표면 1 \[probe\]/);
});

test("a drawn slot that its commit neither places nor defers fails V7a", async (t) => {
  const row = await v7aOf(t, { w: 10, h: 10 }, { seq: 10, deferred: [], surfaces: [] });
  assert.equal(row.ok, false);
  assert.match(row.note, /커밋에 없는 표면 1 \[probe\]/);
});
