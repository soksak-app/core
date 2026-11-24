// Checks that an error toast stays the topmost layer while a dialog surface is open (F1147-1, docs/spec/native-modals.md#toast-overlay):
// the sync request cuts the toast out of the container of the surface hosts, which holds the dialog host, and the close control of the
// toast is not behind the dialog, so an error of the workbench that appears while a dialog is open shows above the dialog and closes on a
// press.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const wire = selectPageWire("overlay-routing-toast-dialog-sync");
const dom = new JSDOM('<div id="plane"></div><div id="errorToasts"><div class="error-toast"><button id="dismiss"></button></div></div><button id="out"></button>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 1024;
globalThis.innerHeight = 768;
const { behindDialog, orderedCallsAnswered, surfaces } = await import("../host.js");
const { registerDialog } = await import("../registry.js");
const { closeDialog, openDialog } = await import("../dialogs.js");
registerDialog({ plugin: "probe", name: "edit", page: "ui/edit.html", surface: (opener, params) => ({ surfaceId: "dialog/probe/edit", pluginId: "probe", params, section: null, dialog: { name: "edit", opener } }) });

test("an error toast is cut out of the surface hosts and takes the pointer while a dialog surface is open", async () => {
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 768 });
  // JSDOM has no layout, so the toast is given its rectangle in the page.
  document.querySelector(".error-toast").getBoundingClientRect = () => ({ left: 300, top: 520, width: 420, height: 44 });
  const open = openDialog({ plugin: "probe", name: "edit", params: {}, opener: "tab-a", signal: new AbortController().signal, modal: null });
  assert.deepEqual([behindDialog(document.getElementById("dismiss")), behindDialog(document.getElementById("out"))], [false, true]);
  await surfaces.place({ surfaces: [], grabs: [], settled: true, drawn: false });
  await orderedCallsAnswered();
  wire.finish();
  closeDialog("dialog/probe/edit", null);
  await open;
  dom.window.close();
});
