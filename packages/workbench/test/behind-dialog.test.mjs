// An open dialog makes the elements outside it inert, and a picker makes no element inert (docs/spec/exposure.md).
// The page sends the modal calls overlayShow and overlayHide to the host; the cases of docs/spec/cases/page-wire record them.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM(`<div id="plane"></div><div id="settings" data-native-modal="dialog" aria-label="Settings" style="border-top-color: rgb(1, 2, 3); background-color: rgb(4, 5, 6)"><button id="close"></button></div>
  <div id="menu" data-native-modal="menu" aria-label="Menu" style="border-top-color: rgb(7, 8, 9); background-color: rgb(10, 11, 12); border-top-left-radius: 4px"><button id="item"></button></div><button id="out"></button>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
// The host module reads the host wire when it is imported, so a case is selected before the import.
selectPageWire("overlay-none");
const { behindDialog, overlay, orderedCallsAnswered } = await import("../host.js");
const at = (id) => document.getElementById(id);

test("without a modal no element is behind a dialog", async () => {
  const wire = selectPageWire("overlay-none");
  assert.deepEqual([behindDialog(at("out")), behindDialog(null)], [false, false]);
  await orderedCallsAnswered();
  wire.finish();
});

test("an open dialog holds its own elements and stands over every other element and over a surface document", async () => {
  const wire = selectPageWire("overlay-dialog");
  overlay.show(at("settings"), { x: 0, y: 0, w: 800, h: 600 }, () => {});
  assert.deepEqual([behindDialog(at("close")), behindDialog(at("out")), behindDialog(at("item")), behindDialog(null)], [false, true, true, true]);
  overlay.hide();
  assert.equal(behindDialog(at("out")), false);
  await orderedCallsAnswered();
  wire.finish();
});

test("an open picker makes no element inert", async () => {
  const wire = selectPageWire("overlay-menu");
  overlay.show(at("menu"), { x: 10, y: 10, w: 100, h: 60 }, () => {});
  assert.deepEqual([behindDialog(at("item")), behindDialog(at("out")), behindDialog(null)], [false, false, false]);
  overlay.hide();
  await orderedCallsAnswered();
  wire.finish();
});
