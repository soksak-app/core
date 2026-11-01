// Checks that the tab chosen and the sections collapsed in each sidebar are stored in the space and applied again (docs/spec/projects.md#persistence).
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.dispatchEvent = () => true;

// The section surfaces mount through the compositor and the surface modules, which are fakes at the boundary of the module.
mock.module("../compositor.js", { namedExports: { setSlotSurface: () => {}, clearSlotSurface: () => {} } });
mock.module("../surface-modules.js", { namedExports: { mountSurface: () => Promise.resolve() } });

const { registry } = await import("../exposure.js");
const { registerSection } = await import("../registry.js");
const sections = await import("../sidebar-sections.js");

registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const surface = (surfaceId, section) => ({ composition: { kind: "view", page: "ui/section.html" }, surfaceId, pluginId: "probe",
  declarations: {}, sidecars: [], diagnostics: null, unload: false, params: null, section });
registerSection({ id: "probe.one", name: "하나", height: "fill", plugin: "probe", surface });
registerSection({ id: "probe.two", name: "둘", height: 80, plugin: "probe", surface });

test("the selected tab and folded sections are reported for saving and restored from a saved space", () => {
  const tabs = document.createElement("div");
  const list = document.createElement("div");
  tabs.className = "set";
  list.className = "set";
  document.body.append(tabs, list);
  const context = { orientation: "vertical", card: null, surface: null, space: "spc-aaaaaa" };
  sections.drawSet(tabs, "rail-probe", { id: "set-t", title: "T", sections: ["probe.one", "probe.two"], layout: "tabs" }, context);
  sections.drawSet(list, "left", { id: "set-l", title: "L", sections: ["probe.one", "probe.two"], layout: "list" }, context);
  let saved = 0;
  sections.onChoicesChange(() => { saved++; });

  sections.selectSection("rail-probe", "probe.two");
  sections.foldSection("left", "probe.one");
  assert.equal(saved, 2, "a user choice did not ask the space to be saved");
  const choices = sections.sidebarChoices();
  assert.deepEqual(choices, { "rail-probe": { tab: "probe.two", folded: [] }, left: { tab: null, folded: ["probe.one"] } });

  sections.restoreSidebarChoices({});
  const state = () => Object.fromEntries(sections.sidebarsState().map((bar) =>
    [bar.sidebar, { tab: bar.tab, folded: bar.sections.filter((s) => s.folded).map((s) => s.id) }]));
  assert.deepEqual(state().left.folded, []);
  sections.restoreSidebarChoices(choices);
  assert.deepEqual(state(), { "rail-probe": { tab: "probe.two", folded: [] }, left: { tab: null, folded: ["probe.one"] } });
  assert.equal(saved, 2, "restoring a saved space asked for another save");
});

test("a dragged section height is applied, reported, saved with the space and restored", () => {
  const list = document.createElement("div");
  const tabs = document.createElement("div");
  list.className = "set";
  tabs.className = "set";
  document.body.append(list, tabs);
  registerSection({ id: "probe.three", name: "셋", height: 60, plugin: "probe", surface });
  const context = { orientation: "vertical", card: null, surface: null, space: "spc-bbbbbb" };
  sections.restoreSidebarChoices({});
  sections.drawSet(list, "right", { id: "set-r", title: "R", sections: ["probe.one", "probe.two", "probe.three"], layout: "list" }, context);
  sections.drawSet(tabs, "rail-sizes", { id: "set-s", title: "S", sections: ["probe.one", "probe.two"], layout: "tabs" }, context);
  const dividers = () => [...list.querySelectorAll(".set__divider:not([hidden])")].map((divider) => divider.dataset.section);
  assert.deepEqual(dividers(), ["probe.two", "probe.three"], "each two adjacent open sections need one divider, named by the section below it");
  let saved = 0;
  sections.onChoicesChange(() => { saved++; });

  sections.sizeSection("right", "probe.one", 240);
  const element = list.querySelector('[data-section="probe.one"]');
  assert.equal(element.dataset.height, "240", "a sized fill section keeps its declared height");
  assert.equal(element.style.getPropertyValue("--section-height"), "240px");
  const sizes = () => Object.fromEntries(sections.sidebarsState().find((bar) => bar.sidebar === "right").sections.map((s) => [s.id, s.size]));
  assert.deepEqual(sizes(), { "probe.one": 240, "probe.two": null, "probe.three": null });
  assert.equal(saved, 1, "a size did not ask the space to be saved");
  assert.deepEqual(sections.sidebarChoices().right, { tab: null, folded: [], sizes: { "probe.one": 240 } });
  assert.deepEqual(sections.sidebarChoices()["rail-sizes"], { tab: "probe.one", folded: [] }, "a sidebar without sizes omits them");

  sections.foldSection("right", "probe.two");
  assert.deepEqual(dividers(), [], "a divider next to a folded section remains");
  sections.foldSection("right", "probe.two");

  assert.throws(() => sections.sizeSection("rail-sizes", "probe.one", 100), { message: "sidebar rail-sizes does not use the list layout" });
  assert.throws(() => sections.sizeSection("right", "probe.missing", 100), { message: "sidebar right has no section probe.missing" });
  for (const height of [31, 4097, 100.5, "100"]) {
    assert.throws(() => sections.sizeSection("right", "probe.two", height),
      { message: `section height must be an integer from 32 to 4096, got ${JSON.stringify(height)}` });
  }

  const choices = sections.sidebarChoices();
  sections.restoreSidebarChoices({});
  assert.deepEqual(sizes(), { "probe.one": null, "probe.two": null, "probe.three": null });
  assert.equal(element.dataset.height, "fill");
  sections.restoreSidebarChoices(choices);
  assert.deepEqual(sizes(), { "probe.one": 240, "probe.two": null, "probe.three": null });
  assert.throws(() => sections.restoreSidebarChoices({ right: { tab: null, folded: [], sizes: { "probe.one": 10 } } }),
    { message: "sidebar right stores an invalid size of probe.one: 10" });
});
