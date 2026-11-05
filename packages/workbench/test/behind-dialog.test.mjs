// An open dialog makes the elements outside it inert, and a picker makes no element inert (docs/spec/exposure.md).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<div id="plane"></div><div id="settings" data-native-modal="dialog" aria-label="Settings"><button id="close"></button></div>
  <div id="menu" data-native-modal="menu" aria-label="Menu"><button id="item"></button></div><button id="out"></button>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => Promise.resolve(() => {}), page: (path) => path, call: async () => {},
} } });
const { behindDialog, overlay } = await import("../host.js");
const at = (id) => document.getElementById(id);

test("without a modal no element is behind a dialog", () => {
  assert.deepEqual([behindDialog(at("out")), behindDialog(null)], [false, false]);
});

test("an open dialog holds its own elements and stands over every other element and over a surface document", () => {
  overlay.show(at("settings"), { x: 0, y: 0, w: 800, h: 600 }, () => {});
  assert.deepEqual([behindDialog(at("close")), behindDialog(at("out")), behindDialog(at("item")), behindDialog(null)], [false, true, true, true]);
  overlay.hide();
  assert.equal(behindDialog(at("out")), false);
});

test("an open picker makes no element inert", () => {
  overlay.show(at("menu"), { x: 10, y: 10, w: 100, h: 60 }, () => {});
  assert.deepEqual([behindDialog(at("item")), behindDialog(at("out")), behindDialog(null)], [false, false, false]);
  overlay.hide();
});
