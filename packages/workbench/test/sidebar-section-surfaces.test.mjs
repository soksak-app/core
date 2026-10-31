// Checks that each drawn sidebar section is a section surface of its plugin (docs/spec/plugins.md#sections): its body is the
// slot of a view surface with the id <sidebar id>/<section id>, the surface lives while the section is in its set, folding or
// an unselected tab hides it without a release, and core.sidebars reports its surface id and the surface it follows.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.ErrorEvent = dom.window.ErrorEvent;
const reported = [];
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };

// The compositor and the surface mounts are fakes at the boundary of the module: they record the slots and the surfaces.
const slots = new Map();
const mounts = [];
const disposed = [];
mock.module("../compositor.js", { namedExports: {
  setSlotSurface: (slot, surface) => { slots.set(slot, surface); },
  clearSlotSurface: (slot) => { slots.delete(slot); },
} });
mock.module("../surface-modules.js", { namedExports: {
  mountSurface: (slot, surface) => { mounts.push({ slot, surface }); return Promise.resolve(); },
  // The sidebar never disposes a surface itself; a call is recorded so that a test can show it.
  disposeSurface: (surfaceId) => { disposed.push(surfaceId); return Promise.resolve(); },
} });
mock.module("../host.js", { namedExports: { report: () => {} } });

const { registry } = await import("../exposure.js");
const { registerSection } = await import("../registry.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { drawSet, sidebarsState, clearSet, foldSection, selectSection } = await import("../sidebar-sections.js");
const { shownSectionSurfaces } = await import("../section-surfaces.js");

const composition = { kind: "view", page: "ui/tree.html" };
const descriptor = (pluginId, section) => (surfaceId, start) => ({ composition: section.composition, surfaceId, pluginId,
  declarations: {}, sidecars: [], diagnostics: null, unload: false, params: null, section: start });
for (const section of [
  { id: "probe.tree", name: "Tree", composition, height: "fill" },
  { id: "probe.marks", name: "Marks", composition, height: 120 },
]) registerSection({ ...section, plugin: "probe", surface: descriptor("probe", section) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const list = { id: "probe.list", title: "List", layout: "list", sections: ["probe.tree", "probe.marks"] };
const tabs = { id: "probe.tabs", title: "Tabs", layout: "tabs", sections: ["probe.tree", "probe.marks"] };

function sidebar() {
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  return container;
}

test("each section body is the slot of a view surface named <sidebar id>/<section id>", async () => {
  mounts.length = 0;
  const container = sidebar();
  try {
    drawSet(container, "c1:left", list, { card: "c1", surface: "t1", orientation: "vertical" });
    await settle();
    const bodies = [...container.querySelectorAll(".set__body")];
    assert.deepEqual(bodies.map((body) => body.dataset.nativeSurfaceId), ["c1:left/probe.tree", "c1:left/probe.marks"]);
    assert.deepEqual(bodies.map((body) => body.dataset.nativePlugin), ["probe", "probe"]);
    assert.ok(bodies.every((body) => body.dataset.nativeSurface !== undefined), "a section body must be a native surface slot");
    assert.deepEqual(mounts.map(({ surface }) => [surface.surfaceId, surface.section]), [
      ["c1:left/probe.tree", { id: "probe.tree", sidebar: "c1:left", card: "c1" }],
      ["c1:left/probe.marks", { id: "probe.marks", sidebar: "c1:left", card: "c1" }],
    ]);
    assert.ok(mounts.every(({ slot, surface }) => slots.get(slot) === surface), "the slot must carry the mounted descriptor");
  } finally { clearSet(container); container.remove(); }
});

test("a window sidebar section starts with card null", async () => {
  mounts.length = 0;
  const container = sidebar();
  try {
    drawSet(container, "left", list, { card: null, surface: null, orientation: "vertical", window: true, plugin: null, side: "left" });
    await settle();
    assert.deepEqual(mounts.map(({ surface }) => surface.section), [
      { id: "probe.tree", sidebar: "left", card: null }, { id: "probe.marks", sidebar: "left", card: null }]);
  } finally { clearSet(container); container.remove(); }
});

test("folding and an unselected tab hide a section surface without releasing it", async () => {
  mounts.length = 0; disposed.length = 0;
  const listed = sidebar();
  const tabbed = sidebar();
  try {
    drawSet(listed, "c2:left", list, { card: "c2", surface: "t2", orientation: "vertical" });
    drawSet(tabbed, "c2:right", tabs, { card: "c2", surface: "t2", orientation: "vertical" });
    await settle();
    foldSection("c2:left", "probe.tree");
    selectSection("c2:right", "probe.marks");
    await settle();
    assert.deepEqual(disposed, [], "a hidden section surface must stay mounted");
    assert.equal(mounts.length, 4, "every section of both sets must mount once");
    const tree = listed.querySelector('[data-native-surface-id="c2:left/probe.tree"]');
    assert.ok(tree.closest("[hidden]") || tree.hidden || tree.closest('[data-folded="true"]'), "a folded section body must be hidden");
    const unselected = tabbed.querySelector('[data-native-surface-id="c2:right/probe.tree"]');
    assert.ok(unselected.closest("[hidden]"), "the section of an unselected tab must be hidden");
  } finally { clearSet(listed); clearSet(tabbed); listed.remove(); tabbed.remove(); }
});

test("a change of the active tab keeps the section surfaces and core.sidebars reports the followed surface", async () => {
  mounts.length = 0; disposed.length = 0;
  const container = sidebar();
  try {
    drawSet(container, "c3:left", list, { card: "c3", surface: "t1", orientation: "vertical" });
    await settle();
    drawSet(container, "c3:left", list, { card: "c3", surface: "t2", orientation: "vertical" });
    await settle();
    assert.equal(mounts.length, 2, "a change of the followed tab must not mount the sections again");
    assert.deepEqual(disposed, []);
    const state = sidebarsState().find((entry) => entry.sidebar === "c3:left");
    assert.deepEqual(state.sections.map(({ id, surfaceId, surface }) => ({ id, surfaceId, surface })), [
      { id: "probe.tree", surfaceId: "c3:left/probe.tree", surface: "t2" },
      { id: "probe.marks", surfaceId: "c3:left/probe.marks", surface: "t2" },
    ]);
  } finally { clearSet(container); container.remove(); }
});

test("a drawn set records its section surfaces as shown, and clearing it leaves their release to the commit", async () => {
  disposed.length = 0;
  const container = sidebar();
  drawSet(container, "c4:left", list, { card: "c4", surface: null, orientation: "vertical" });
  await settle();
  assert.deepEqual(shownSectionSurfaces().filter((id) => id.startsWith("c4:")), ["c4:left/probe.tree", "c4:left/probe.marks"]);
  const bodies = [...container.querySelectorAll(".set__body")];
  clearSet(container);
  container.remove();
  await settle();
  assert.deepEqual(shownSectionSurfaces().filter((id) => id.startsWith("c4:")), []);
  assert.ok(bodies.every((body) => !slots.has(body)), "a cleared section body must hold no surface descriptor");
  // A commit that no longer holds the surface releases it, as it releases the surface of a closed tab (docs/spec/plugins.md#sections).
  assert.deepEqual(disposed, []);
});

test("a section has its declared height and a fill section shares the remaining height", async () => {
  const container = sidebar();
  try {
    drawSet(container, "c5:left", list, { card: "c5", surface: null, orientation: "vertical" });
    await settle();
    const [tree, marks] = container.querySelectorAll(".set__section");
    assert.equal(tree.dataset.height, "fill");
    assert.equal(marks.dataset.height, "120");
    assert.equal(marks.style.getPropertyValue("--section-height"), "120px");
  } finally { clearSet(container); container.remove(); }
});

test("section layout rejects an absent or invalid orientation explicitly", () => {
  const container = sidebar();
  const set = { id: "shared-set", title: "Shared", layout: "list", sections: [] };
  try {
    for (const orientation of [undefined, null, "diagonal"]) {
      assert.throws(() => drawSet(container, "invalid-mode", set, { card: "card", surface: null, orientation }),
        /orientation must be horizontal or vertical/);
    }
  } finally { clearSet(container); container.remove(); }
});

test("horizontal list sections use a row while vertical lists use a column", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const styled = new JSDOM(`<style>${css}</style><div class="set" data-layout="list" data-orientation="horizontal"></div><div class="set" data-layout="list" data-orientation="vertical"></div>`);
  try {
    const [horizontal, vertical] = styled.window.document.querySelectorAll(".set");
    assert.equal(styled.window.getComputedStyle(horizontal).flexDirection, "row");
    assert.equal(styled.window.getComputedStyle(vertical).flexDirection, "column");
  } finally { styled.window.close(); }
});
