// Checks that a drag of a section divider changes only the two sections beside it, through core.sidebar.section.size {sidebar, heights}
// (docs/spec/plugins.md#sections).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.dispatchEvent = () => true;

const { registry } = await import("../exposure.js");
const { registerPlugin, registerSection } = await import("../registry.js");
const sections = await import("../sidebar-sections.js");

registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
registerPlugin({ id: "probe", name: "Probe", mark: "p", svg: "<path/>", ink: null, drop: null, background: null, surface: () => null });
const surface = (surfaceId, section) => ({ composition: { kind: "view", page: "ui/section.html" }, surfaceId, pluginId: "probe",
  declarations: {}, sidecars: [], diagnostics: null, unload: false, params: null, section });
registerSection({ actions: [], id: "probe.tree", name: "트리", height: "fill", plugin: "probe", surface });
registerSection({ actions: [], id: "probe.running", name: "실행", height: 100, plugin: "probe", surface });
registerSection({ actions: [], id: "probe.defined", name: "정의", height: 100, plugin: "probe", surface });

const section = (id, height, fills = false) => ({ id, height, fills });

test("a divider between two sections with integer heights sizes both and leaves the fill section elsewhere", () => {
  const open = [section("tree", 300, true), section("running", 100), section("defined", 100)];
  assert.deepEqual(sections.dividerHeights(open, 2, -20), { running: 80, defined: 120 });
  assert.deepEqual(sections.dividerHeights(open, 2, 20), { running: 120, defined: 80 });
});

test("a fill section beside the divider takes the change when no other open section fills", () => {
  assert.deepEqual(sections.dividerHeights([section("a", 300, true), section("b", 100)], 1, -20), { b: 120 });
  assert.deepEqual(sections.dividerHeights([section("a", 100), section("b", 300, true)], 1, 30), { a: 130 });
  assert.deepEqual(sections.dividerHeights([section("a", 200, true), section("b", 200, true), section("c", 100)], 1, 10), { a: 210 });
});

test("a fill section beside the divider is sized when another open section fills", () => {
  const open = [section("a", 150, true), section("b", 100), section("c", 150, true)];
  assert.deepEqual(sections.dividerHeights(open, 1, 10), { a: 160, b: 90 });
});

test("the drag stops where one of the two sections would be lower than the minimum height", () => {
  const open = [section("tree", 300, true), section("running", 100), section("defined", 100)];
  assert.deepEqual(sections.dividerHeights(open, 2, -400), { running: 32, defined: 168 });
  assert.deepEqual(sections.dividerHeights(open, 2, 400), { running: 168, defined: 32 });
});

test("core.sidebar.section.size sets every height at once and refuses empty heights", () => {
  const list = document.createElement("div");
  list.className = "set";
  document.body.append(list);
  const context = { orientation: "vertical", card: null, surface: null, space: "spc-aaaaaa" };
  sections.drawSet(list, "left", { id: "set-l", title: "L", sections: ["probe.tree", "probe.running", "probe.defined"], layout: "list" }, context);
  let changes = 0;
  sections.onSectionsChange(() => { changes++; });
  sections.sizeSections("left", { "probe.running": 80, "probe.defined": 120 });
  assert.equal(changes, 1, "two heights did not change the sections at once");
  const sizes = Object.fromEntries(sections.sidebarsState().find((entry) => entry.sidebar === "left").sections.map((entry) => [entry.id, entry.size]));
  assert.deepEqual(sizes, { "probe.tree": null, "probe.running": 80, "probe.defined": 120 });
  assert.throws(() => sections.sizeSections("left", {}), /section heights must name at least one section/);
  assert.throws(() => sections.sizeSections("left", { "probe.running": 31 }), /section height must be an integer from 32 to 4096, got 31/);
});
