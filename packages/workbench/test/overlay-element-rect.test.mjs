// The element of a modal that its main document hides stands where the modal document draws it (docs/spec/exposure.md): each host answers the place in the window.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const listeners = {};
const dom = new JSDOM(`<div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu"><button id="one" data-expose="core.picker.item"></button>
  <button id="two" data-expose="core.picker.item"></button><span id="name" data-expose="core.picker.item-name"></span></div><button id="out" data-expose="core.other"></button>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
mock.module("@soksak/runtime", { namedExports: { host: {
  on: (name, listener) => { listeners[name] = listener; return Promise.resolve(() => {}); }, page: (path) => path, call: async () => {},
} } });
const { overlay, overlayElementRect } = await import("../host.js");
const at = (id) => document.getElementById(id);
const report = (value) => listeners["overlay-pick"]({ id: "menu", key: "document", value: JSON.stringify(value) });
const reported = [
  { name: "core.picker.item", x: 0, y: 2, width: 160, height: 27 },
  { name: "core.picker.item", x: 0, y: 29, width: 160, height: 27 },
  { name: "core.picker.item-name", x: 30, y: 7, width: 87, height: 17 },
];

test("an element of a modal that the main document does not hide keeps its own rectangle", () => {
  overlay.show(at("menu"), { x: 715, y: 142, w: 160, h: 60 }, () => {});
  assert.equal(overlayElementRect(at("one")), null);
  overlay.hide();
});

test("an element of a hidden modal stands in the modal, which is the document of its place", () => {
  at("menu").hidden = true;
  overlay.show(at("menu"), { x: 715, y: 142, w: 160, h: 60 }, () => {});
  assert.throws(() => overlayElementRect(at("one")), /modal menu has not reported its elements/);
  report({ elements: reported });
  assert.deepEqual(overlayElementRect(at("two")), { x: 0, y: 29, width: 160, height: 27, document: { x: 715, y: 142 } });
  assert.deepEqual(overlayElementRect(at("name")), { x: 30, y: 7, width: 87, height: 17, document: { x: 715, y: 142 } });
  overlay.place(at("menu"), { x: 700, y: 150, w: 160, h: 60 });
  assert.deepEqual(overlayElementRect(at("one")).document, { x: 700, y: 150 });
  assert.equal(overlayElementRect(at("out")), null);
  report({ elements: reported.slice(2) });
  assert.throws(() => overlayElementRect(at("one")), /modal menu has reported no element core.picker.item at index 0/);
  overlay.hide();
  assert.equal(overlayElementRect(at("one")), null);
  at("menu").hidden = false;
});
