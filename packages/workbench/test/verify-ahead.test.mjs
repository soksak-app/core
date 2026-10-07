// 검증 V7c 가 실패하면 원인을 찾을 수 있도록 가장 크게 어긋난 표면과 그 두 자리를 밝힌다(F33).
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
  // 그려진 카드의 자리와 style, 페이지의 device pixel ratio 는 실패 문장이 밝히는 측정값이다(F90).
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

test("a failed V7b names the surface and its declared and applied rectangles", async (t) => {
  const dom = new JSDOM('<div class="chrome-bar"></div><div id="stage"><div id="plane"></div></div>');
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  t.after(() => dom.window.close());
  const plane = document.querySelector("#plane");
  plane.getBoundingClientRect = () => rect(6, 6, 400, 300);
  const grid = new Soksak(undefined, { width: 400, height: 300 });
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
