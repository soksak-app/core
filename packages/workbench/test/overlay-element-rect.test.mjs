// The element of a native modal stands where the modal document draws the copy of it that the person sees (docs/spec/exposure.md):
// the copy scrolls and redraws apart from the main document, so the main document's own rectangle names a place the person does not
// see. The root of the modal keeps the rectangle of the main document, because the copy holds its children and no element of its name.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const listeners = {};
const dom = new JSDOM(`<div id="plane"></div><div id="menu" data-native-modal="menu" aria-label="Menu"><button id="one" data-expose="core.picker.item"></button>
  <button id="two" data-expose="core.picker.item"></button><span id="name" data-expose="core.picker.item-name"></span></div>
  <div id="settings" data-native-modal="dialog" aria-label="Settings"><button id="switch" data-expose="core.settings-modal.set"></button></div>
  <button id="out" data-expose="core.other"></button>`);
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
const report = (id, value) => listeners["overlay-pick"]({ id, key: "document", value: JSON.stringify(value) });
const reported = [
  { name: "core.picker.item", x: 0, y: 2, width: 160, height: 27 },
  { name: "core.picker.item", x: 0, y: 29, width: 160, height: 27 },
  { name: "core.picker.item-name", x: 30, y: 7, width: 87, height: 17 },
];

test("an element of a modal that hides with visibility, like a dialog, answers the place of the scrolled copy", () => {
  at("settings").style.visibility = "hidden";
  overlay.show(at("settings"), { x: 0, y: 0, w: 800, h: 600 }, () => {});
  assert.equal(overlayElementRect(at("settings")), null, "the modal root keeps the rectangle of the main document");
  assert.throws(() => overlayElementRect(at("switch")), /modal settings has not reported its elements/);
  report("settings", { elements: [{ name: "core.settings-modal.set", x: 468, y: 115, width: 40, height: 22 }] });
  assert.deepEqual(overlayElementRect(at("switch")), { x: 468, y: 115, width: 40, height: 22, document: { x: 0, y: 0 } });
  overlay.hide();
  assert.equal(overlayElementRect(at("switch")), null);
  at("settings").style.visibility = "";
});

test("an element of a modal that hides its box, like a menu, answers the same way and the report bounds it", () => {
  at("menu").hidden = true;
  overlay.show(at("menu"), { x: 715, y: 142, w: 160, h: 60 }, () => {});
  assert.equal(overlayElementRect(at("menu")), null, "the modal root keeps the rectangle of the main document");
  assert.throws(() => overlayElementRect(at("one")), /modal menu has not reported its elements/);
  report("menu", { elements: reported });
  assert.deepEqual(overlayElementRect(at("two")), { x: 0, y: 29, width: 160, height: 27, document: { x: 715, y: 142 } });
  assert.deepEqual(overlayElementRect(at("name")), { x: 30, y: 7, width: 87, height: 17, document: { x: 715, y: 142 } });
  overlay.place(at("menu"), { x: 700, y: 150, w: 160, h: 60 });
  assert.deepEqual(overlayElementRect(at("one")).document, { x: 700, y: 150 });
  assert.equal(overlayElementRect(at("out")), null);
  report("menu", { elements: reported.slice(2) });
  assert.throws(() => overlayElementRect(at("one")), /modal menu has reported no element core.picker.item at index 0/);
  overlay.hide();
  assert.equal(overlayElementRect(at("one")), null);
  at("menu").hidden = false;
});
