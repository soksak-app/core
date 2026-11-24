// While a dialog surface is open, it holds the keyboard of the window as a modal of the kind dialog (docs/spec/exposure.md#keyboard-focus):
// the keyboard waits for the placement that shows the dialog, goes to the dialog surface, and returns to the ring when the dialog ends.
// The host calls of the page are answered by the case keyboard-dialog of docs/spec/cases/page-wire.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM(`<div id="plane"></div>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// The host module reads the host wire when it is imported, so the case is selected before the import.
const wire = selectPageWire("keyboard-dialog");
const { followRing, idle, keyboardPlaced } = await import("../keyboard.js");
const { registerDialog } = await import("../registry.js");
const { closeDialog, openDialog } = await import("../dialogs.js");

const dialog = "dialog/probe/edit";
registerDialog({ plugin: "probe", name: "edit", page: "ui/edit.html",
  surface: (opener, params) => ({ surfaceId: dialog, pluginId: "probe", params, section: null, dialog: { name: "edit", opener } }) });
const focusCalls = () => wire.calls.filter(({ name }) => name === "surfaceFocus").map(({ payload }) => payload.surface);

test("the keyboard waits for the placement of the dialog, goes to the dialog surface, and returns to the ring when it ends", async () => {
  // No card holds the ring, so the keyboard of the window without a dialog is with the workbench.
  followRing(() => null);
  const open = openDialog({ plugin: "probe", name: "edit", params: null, opener: "tab-a", signal: new AbortController().signal, modal: null });
  await idle();
  assert.deepEqual(focusCalls(), [], "no placement holds the dialog surface yet");
  await keyboardPlaced([dialog], [dialog]);
  assert.deepEqual(focusCalls(), [dialog]);
  closeDialog(dialog, null);
  await open;
  await idle();
  await keyboardPlaced([], []);
  assert.deepEqual(focusCalls(), [dialog, null]);
  wire.finish();
});
