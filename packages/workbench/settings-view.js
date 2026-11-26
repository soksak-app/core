// The settings surface of the plugin page of the settings window (docs/spec/plugins.md#settings-views). While the settings window shows
// the page of a plugin that declares a settings view, the window holds its settings surface settings/<plugin>, and the plane draws its
// seat in each draw (drawSettingsSeat), so the placement that follows holds the surface at the seat; the end of the page leaves the seat
// out of the next draw, which releases the surface as the close of a tab releases its surface. On the Wails and Tauri hosts the settings
// window is a native modal, so the seat is measured from the elements that the modal document reports, and the surface carries the pane
// as its clip (docs/spec/native-surfaces.md#settings-seat). This module reads no document at its load, because the modules of the
// surfaces read it, and settings-seat.js draws the seat.
import { modalElementWindowRect, onModalState } from "./host.js";
import { settingsView as declaredSettingsView } from "./registry.js";
import { hideError, showError } from "./shown-errors.js";

const SEAT = "core.settings-modal.plugin-view";
const PANE = "core.settings-modal.pane";

/* The settings surface of the shown plugin page: {surface, plugin, slot, mounted, seat, height}, or null. seat is the last measured seat and
   height the content height that its view reported, null before the first report. */
let open = null;
/* The plugin whose plugin page the settings window shows, or null. */
let shownPlugin = null;
/* The plugin whose view stopped its restarts, which has no settings surface until its page is shown again. */
let stopped = null;
const listeners = new Set();
const changed = () => {
  for (const fn of [...listeners]) fn();
};

/** Calls fn when the settings surface opens, ends or its seat moves. Returns the function that removes it. */
export function onSettingsViewChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The place of the error display of the settings view of plugin.
const errorPlace = (plugin) => `settings ${plugin}`;

/**
 * Follows the plugin page that the settings window shows: plugin is the plugin of the page, or null when the window shows another page,
 * another section or is closed. A page of a plugin that declares a settings view holds its settings surface; a repeated call with the
 * same plugin changes nothing, and a page shown again after the view stopped its restarts creates the surface again.
 */
export function showSettingsView(plugin) {
  if (plugin !== shownPlugin) {
    shownPlugin = plugin;
    stopped = null;
  }
  const declared = plugin === null || plugin === stopped ? null : declaredSettingsView(plugin);
  if (open !== null && declared !== null && open.plugin === plugin) return;
  if (open === null && declared === null) return;
  open = null;
  if (declared !== null) {
    hideError(document, errorPlace(plugin));
    const surface = declared.surface();
    const slot = document.createElement("div");
    slot.className = "settings-seat slot";
    slot.dataset.nativeSurface = "view";
    slot.dataset.nativeSurfaceId = surface.surfaceId;
    slot.dataset.nativeSeat = "settings";
    // The settings surface stands over the settings window, whose content it is (docs/spec/native-modals.md#settings-surface).
    slot.dataset.nativeLayer = "40";
    slot.dataset.nativePlugin = plugin;
    slot.dataset.nativeTitle = "settings";
    slot.dataset.nativeDim = "false";
    open = { surface, plugin, slot, mounted: false, seat: null, height: null };
  }
  changed();
}

/** The plugin of the surface when it is the open settings surface, or null for any other surface. */
export const settingsSurfacePlugin = (surface) => (open !== null && open.surface.surfaceId === surface ? open.plugin : null);

/** The surface id of the open settings surface, or null. */
export const settingsSurface = () => (open === null ? null : open.surface.surfaceId);

/**
 * Sets the height of the seat of the settings surface to the content height that its view reports with runtime.seat.height
 * (docs/spec/plugins.md#settings-views), and tells the listeners when it changes. A surface that is not the open settings surface is refused.
 */
export function setSeatHeight(surface, height) {
  if (settingsSurfacePlugin(surface) === null) throw new Error("view call runtime.seat.height is served only for a settings surface");
  if (open.height === height) return;
  open.height = height;
  changed();
}

/** The content height that the view of the open settings surface reported, or null before the first report or without a surface. */
export const seatContentHeight = () => (open === null ? null : open.height);

/**
 * The seat of the settings surface: frame is the rectangle of the element core.settings-modal.plugin-view and clip the rectangle of the
 * pane core.settings-modal.pane, in CSS pixels of the window, as the modal document reported them; null before it reported both.
 */
export function settingsSeat() {
  const frame = modalElementWindowRect(SEAT);
  const clip = modalElementWindowRect(PANE);
  return frame === null || clip === null ? null : { frame, clip };
}

const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const sameSeat = (a, b) => (a === null || b === null ? a === b : sameRect(a.frame, b.frame) && sameRect(a.clip, b.clip));

// Each report of the modal document can move the seat, by a scroll of the pane, a placement of the card or a draw of the page.
onModalState(() => {
  if (open !== null && !sameSeat(open.seat, settingsSeat())) changed();
});

/** The open settings surface entry {surface, plugin, slot, mounted, seat}, which the seat draws, or null. */
export const openSettingsEntry = () => open;

/**
 * Ends the settings surface entry with the error text of its view, which the error display shows at settings <plugin>, until the page of
 * the plugin is shown again. A view of a surface that already ended shows no error, because the window no longer shows its page.
 */
export function failSettingsView(entry, text) {
  if (open !== entry) return;
  open = null;
  stopped = entry.plugin;
  changed();
  showError(document, errorPlace(entry.plugin), text);
}
