// Checks the dialog of the window (docs/spec/plugins.md#dialogs): a view opens a declared dialog, which the window holds alone and
// refuses beside a native modal; the open call resolves with the result of the close of the dialog view and every other end of it
// removes the dialog; core.modal reports the dialog with its plugin; and the dialog stands over every element of the main page and over
// the document of every other surface.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM(`<div id="plane"></div><div id="settings" data-native-modal="dialog" aria-label="Settings"><button id="close"></button></div><button id="out"></button>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
// The host module reads the host wire when it is imported, so a case is selected before the import.
selectPageWire("overlay-none");
const { behindDialog, modalState, onModalState, overlay } = await import("../host.js");
const { registerDialog } = await import("../registry.js");
const { closeDialog, dialogState, openDialog } = await import("../dialogs.js");
const at = (id) => document.getElementById(id);

const surfaceOf = (name) => (opener, params) => ({ surfaceId: `dialog/probe/${name}`, pluginId: "probe", params, section: null, dialog: { name, opener } });
registerDialog({ plugin: "probe", name: "edit", page: "ui/edit.html", surface: surfaceOf("edit") });
registerDialog({ plugin: "probe", name: "confirm", page: "ui/confirm.html", surface: surfaceOf("confirm") });

const opening = (name, { signal = new AbortController().signal, modal = null, opener = "tab-a" } = {}) =>
  openDialog({ plugin: "probe", name, params: { row: 3 }, opener, signal, modal });

test("an open dialog resolves with the result of the close of the dialog view, and the window then shows none", async () => {
  const open = opening("edit");
  assert.deepEqual(dialogState(), { surface: "dialog/probe/edit", plugin: "probe", name: "edit", opener: "tab-a" });
  closeDialog("dialog/probe/edit", { saved: true });
  assert.deepEqual(await open, { saved: true });
  assert.equal(dialogState(), null);
});

test("a dialog that the plugin does not declare, a second dialog and a dialog beside a native modal are refused", async () => {
  assert.throws(() => opening("other"), /^Error: view call runtime\.dialog\.open other is not a dialog of probe$/);
  assert.throws(() => opening("edit", { modal: "settings" }), /^Error: view call runtime\.dialog\.open: the window shows the modal settings$/);
  const open = opening("edit");
  assert.throws(() => opening("confirm"), /^Error: view call runtime\.dialog\.open: the window shows the dialog edit of probe$/);
  closeDialog("dialog/probe/edit", null);
  await open;
});

test("a close from a view that is not the open dialog is refused and leaves the dialog open", async () => {
  assert.throws(() => closeDialog("dialog/probe/edit", null), /^Error: view call runtime\.dialog\.close is served only to a dialog$/);
  const open = opening("edit");
  assert.throws(() => closeDialog("tab-a", null), /^Error: view call runtime\.dialog\.close is served only to a dialog$/);
  assert.equal(dialogState()?.name, "edit");
  closeDialog("dialog/probe/edit", 1);
  assert.equal(await open, 1);
});

test("an end of the open call other than its reply removes the dialog and rejects the call", async () => {
  const controller = new AbortController();
  const open = opening("edit", { signal: controller.signal });
  controller.abort();
  await assert.rejects(open, /^Error: cancelled$/);
  assert.equal(dialogState(), null);
});

test("core.modal reports the open dialog with its plugin and a native modal with plugin null, and each change is announced", async () => {
  const seen = [];
  const stop = onModalState(() => seen.push(modalState()?.mode ?? null));
  const open = opening("edit");
  assert.deepEqual(modalState(), { id: "dialog/probe/edit", mode: "dialog", document: null, plugin: "probe" });
  closeDialog("dialog/probe/edit", null);
  await open;
  assert.equal(modalState(), null);
  stop();
  assert.deepEqual(seen, ["dialog", null]);
});

test("a native modal is refused while a dialog is open", async () => {
  const open = opening("edit");
  assert.throws(() => overlay.show(at("settings"), { x: 0, y: 0, w: 800, h: 600 }, () => {}), /^Error: the window shows the dialog edit of probe$/);
  assert.equal(modalState().id, "dialog/probe/edit", "the refused modal did not open");
  closeDialog("dialog/probe/edit", null);
  await open;
});

test("an open dialog stands over every element of the main page and over the document of every other surface, but not its own", async () => {
  const open = opening("edit");
  assert.deepEqual([behindDialog(at("out")), behindDialog(at("close")), behindDialog(null, "tab-a"), behindDialog(null, "dialog/probe/edit")],
    [true, true, true, false]);
  closeDialog("dialog/probe/edit", null);
  await open;
  assert.deepEqual([behindDialog(at("out")), behindDialog(null, "tab-a")], [false, false]);
});

test("the plane draws the seat of the open dialog below the title bar and removes it when the dialog ends", async () => {
  const { drawDialogSeat } = await import("../dialog-seat.js");
  const plane = at("plane");
  const open = opening("edit");
  drawDialogSeat(plane, 38);
  const seat = plane.querySelector(":scope > .dialog-seat");
  assert.deepEqual([seat?.dataset.nativeSurfaceId, seat?.dataset.nativeSeat, seat?.dataset.nativePlugin, seat?.style.top],
    ["dialog/probe/edit", "dialog", "probe", "38px"]);
  drawDialogSeat(plane, 40);
  assert.deepEqual([plane.querySelectorAll(":scope > .dialog-seat").length, seat.style.top], [1, "40px"], "a later draw keeps one seat");
  closeDialog("dialog/probe/edit", null);
  await open;
  drawDialogSeat(plane, 40);
  assert.equal(plane.querySelector(":scope > .dialog-seat"), null);
});
