// The dialog of the window (docs/spec/plugins.md#dialogs). A view opens a declared page of its plugin as the dialog surface, whose
// seat is the content of the window below the title bar; a window holds one dialog at a time. The plane draws the seat of the open
// dialog in each draw (dialog-seat.js), so the placement that follows holds the dialog surface, and the end of the dialog leaves the
// seat out of the next draw, which releases the surface as the close of a tab releases its surface. This module reads no document
// at its load, because the modules of the surfaces read it.
import { dialog as declaredDialog } from "./registry.js";
import { hideError, showError } from "./shown-errors.js";
import { dialogChanged, useDialogs } from "./host.js";

/* The open dialog: {surface, plugin, name, opener, slot, resolve, reject, mounted}, or null. */
let open = null;
const listeners = new Set();
const changed = () => {
  dialogChanged();
  for (const fn of [...listeners]) fn();
};

/** Calls fn when a dialog opens or ends. Returns the function that removes it. */
export function onDialogChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The surface id of the open dialog, or null when the window shows none. */
export const dialogSurface = () => (open === null ? null : open.surface.surfaceId);

/** The open dialog as the statuses report it, {surface, plugin, name, opener}, or null. */
export const dialogState = () => (open === null ? null
  : { surface: open.surface.surfaceId, plugin: open.plugin, name: open.name, opener: open.opener });

/** The refusal of a native modal while a dialog is open, or null when the window shows no dialog (docs/spec/native-modals.md). */
export const dialogRefusal = () => (open === null ? null : `the window shows the dialog ${open.name} of ${open.plugin}`);

useDialogs({ surface: dialogSurface, state: dialogState, refusal: dialogRefusal });

// The place of the error display of the dialog name of plugin.
const errorPlace = (plugin, name) => `dialog ${plugin} ${name}`;

/**
 * Opens the dialog name of plugin for the view of the surface opener with params, and resolves with the result of its close. The
 * signal is the signal of the open call: every end of the call other than its reply aborts it and removes the dialog. modal is the
 * id of the native modal that the window shows, or null.
 */
export function openDialog({ plugin, name, params, opener, signal, modal }) {
  const declared = declaredDialog(plugin, name);
  if (declared === null) throw new Error(`view call runtime.dialog.open ${name} is not a dialog of ${plugin}`);
  if (open !== null) throw new Error(`view call runtime.dialog.open: ${dialogRefusal()}`);
  if (modal !== null) throw new Error(`view call runtime.dialog.open: the window shows the modal ${modal}`);
  if (signal.aborted) throw new Error("cancelled");
  const surface = declared.surface(opener, params);
  const slot = document.createElement("div");
  slot.className = "dialog-seat slot";
  slot.dataset.nativeSurface = "view";
  slot.dataset.nativeSurfaceId = surface.surfaceId;
  slot.dataset.nativeSeat = "dialog";
  // The dialog stands over every other surface; the native container keeps its host above the others (docs/spec/native-surfaces.md).
  slot.dataset.nativeLayer = "30";
  slot.dataset.nativePlugin = plugin;
  slot.dataset.nativeTitle = name;
  slot.dataset.nativeDim = "false";
  hideError(document, errorPlace(plugin, name));
  return new Promise((resolve, reject) => {
    const entry = { surface, plugin, name, opener, slot, resolve, reject, mounted: false };
    open = entry;
    signal.addEventListener("abort", () => end(entry, () => reject(new Error("cancelled"))), { once: true });
    changed();
  });
}

/** Closes the dialog of the dialog view of the surface caller with result, which the open call of the opener replies with. */
export function closeDialog(caller, result) {
  if (open === null || open.surface.surfaceId !== caller) throw new Error("view call runtime.dialog.close is served only to a dialog");
  const entry = open;
  end(entry, () => entry.resolve(result));
}

/** The open dialog entry {surface, plugin, name, slot, mounted}, which the seat draws, or null. */
export const openDialogEntry = () => open;

/**
 * Ends the dialog entry with the error text of its view, which the error display shows, and the open call fails with it. A view of a
 * dialog that already ended shows no error, because the window no longer shows that dialog.
 */
export function failDialog(entry, text) {
  if (open !== entry) return;
  end(entry, () => entry.reject(new Error(text)));
  showError(document, errorPlace(entry.plugin, entry.name), text);
}

/** Ends the dialog entry when it is the open one: the next draw leaves its seat out, and settle answers the open call. */
function end(entry, settle) {
  if (open !== entry) return;
  open = null;
  settle();
  changed();
}

