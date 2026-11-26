// Checks the settings surface of a plugin page on a host whose settings window is a native modal (docs/spec/plugins.md#settings-views,
// docs/spec/native-surfaces.md#settings-seat): the window holds settings/<plugin> while it shows the page of a plugin that declares a
// settings view, the plane draws its seat at the rectangle of core.settings-modal.plugin-view that the modal document reported with the
// pane as its clip, hides the seat while no part of it lies in the pane, and a view that stopped its restarts ends the surface until
// the page is shown again (F1128-3).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const dom = new JSDOM(`<div id="plane"></div><div id="settings" data-native-modal="dialog" aria-label="Settings" style="border-top-color: rgb(1, 2, 3); background-color: rgb(4, 5, 6)"></div>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.innerWidth = 800;
globalThis.innerHeight = 600;
// The host module reads the host wire when it is imported, so the case is selected before the import.
const wire = selectPageWire("settings-view-seat");
const { overlay, orderedCallsAnswered } = await import("../host.js");
const { registerSettingsView } = await import("../registry.js");
const view = await import("../settings-view.js");
const { drawSettingsSeat } = await import("../settings-seat.js");
const { isSectionSurface, isSettingsSurface, registry } = await import("../exposure.js");
// The error display binds its close control to core.error.dismiss, which the core declarations hold.
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { surfaceKindOf } = await import("../surface-listing.js");
const at = (id) => document.getElementById(id);
const seatOf = () => at("plane").querySelector(":scope > .settings-seat");

const surface = () => ({ surfaceId: "settings/probe", pluginId: "probe", params: null, section: null, dialog: null, settings: true,
  composition: { kind: "view", page: "ui/settings.html" } });
registerSettingsView({ plugin: "probe", surface });

test("the settings surface follows the plugin page, and its seat follows the seat and the pane that the modal document reports", async () => {
  overlay.show(at("settings"), { x: 0, y: 0, w: 800, h: 600 }, () => {});
  await orderedCallsAnswered();
  let changes = 0;
  const stop = view.onSettingsViewChange(() => changes++);
  view.showSettingsView("other");
  assert.equal(view.settingsSurface(), null, "a plugin without a settings view has no settings surface");
  view.showSettingsView("probe");
  assert.deepEqual([view.settingsSurface(), view.settingsSurfacePlugin("settings/probe"), view.settingsSurfacePlugin("tab-a")], ["settings/probe", "probe", null]);
  view.showSettingsView("probe");
  assert.equal(changes, 1, "a repeated show of the same page changes nothing");
  drawSettingsSeat(at("plane"));
  assert.equal(seatOf(), null, "a seat that the modal document has not reported has no slot, so no placement carries it without a clip");
  wire.deliverNotice();
  assert.equal(changes, 2, "the report of the seat is a change of the settings surface");
  drawSettingsSeat(at("plane"));
  assert.deepEqual([seatOf().dataset.nativeSurfaceId, seatOf().dataset.nativeSeat], ["settings/probe", "settings"]);
  assert.deepEqual([seatOf().style.left, seatOf().style.top, seatOf().style.width, seatOf().style.height, seatOf().hidden],
    ["100px", "300px", "400px", "400px", false]);
  assert.deepEqual(JSON.parse(seatOf().dataset.nativeClip), { x: 100, y: 80, w: 400, h: 400 });
  wire.deliverNotice();
  drawSettingsSeat(at("plane"));
  assert.equal(seatOf().hidden, true, "a seat scrolled out of the pane is hidden");
  wire.deliverNotice();
  drawSettingsSeat(at("plane"));
  assert.deepEqual([seatOf().style.top, seatOf().hidden], ["80px", false]);
  view.showSettingsView(null);
  drawSettingsSeat(at("plane"));
  assert.deepEqual([view.settingsSurface(), seatOf()], [null, null], "another page removes the settings surface and its seat");
  stop();
  overlay.hide();
  await orderedCallsAnswered();
  wire.finish();
});

test("a stopped settings view ends its surface with its error until the page of the plugin is shown again", () => {
  view.showSettingsView("probe");
  const entry = view.openSettingsEntry();
  const reason = "the view failed 4 times within 300 seconds and is created again when the settings page of the plugin is shown again";
  view.failSettingsView(entry, reason);
  assert.equal(view.settingsSurface(), null);
  assert.match(document.body.textContent, /the view failed 4 times/);
  view.showSettingsView("probe");
  assert.equal(view.settingsSurface(), null, "the page that is still shown creates no surface again");
  view.showSettingsView(null);
  view.showSettingsView("probe");
  assert.equal(view.settingsSurface(), "settings/probe", "the page shown again creates the surface again");
  view.showSettingsView(null);
});

test("the settings surface is no section, has the kind settings and keeps no tab session", () => {
  assert.deepEqual([isSettingsSurface("settings/probe"), isSettingsSurface("settings/probe/x"), isSettingsSurface("settings")], [true, false, false]);
  assert.equal(isSectionSurface("settings/probe"), false);
  assert.deepEqual(surfaceKindOf(surface()), { kind: "settings", sidebar: null, dialog: null });
});

// The seat takes the content height that its settings view reports with runtime.seat.height: 0 before the first report and again for the
// surface of a page shown again, and a surface that is not the open settings surface is refused (docs/spec/plugins.md#settings-views, F1213).
test("the seat takes the content height that its settings view reports", () => {
  let changes = 0;
  const stop = view.onSettingsViewChange(() => changes++);
  view.showSettingsView("probe");
  assert.equal(view.seatContentHeight(), 0);
  const before = changes;
  view.setSeatHeight("settings/probe", 180);
  assert.equal(view.seatContentHeight(), 180);
  view.setSeatHeight("settings/probe", 180);
  assert.equal(changes, before + 1, "a repeated height changes nothing");
  assert.throws(() => view.setSeatHeight("tab-a", 10), /^Error: view call runtime.seat.height is served only for a settings surface$/);
  view.showSettingsView(null);
  assert.equal(view.seatContentHeight(), 0);
  assert.throws(() => view.setSeatHeight("settings/probe", 10), /served only for a settings surface/);
  view.showSettingsView("probe");
  assert.equal(view.seatContentHeight(), 0, "the surface of a page shown again starts without a report");
  view.showSettingsView(null);
  stop();
});
