// Checks that each drawn sidebar section is a section surface of its plugin (docs/spec/plugins.md#sections): its body is the
// slot of a view surface with the id <space id>/<sidebar id>/<section id>, the surface lives while the section is in its set, folding or
// an unselected tab hides it without a release, and core.sidebars reports its surface id and the surface it follows.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// The compositor reads the slots of the plane, so the sidebars are drawn in the element of the plane.
const dom = new JSDOM('<body><div id="plane"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.dispatchEvent = (event) => dom.window.dispatchEvent(event);

const { registry } = await import("../exposure.js");
const { registerPlugin, registerSection } = await import("../registry.js");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { drawSet, sidebarsState, clearSet, foldSection, selectSection, mountPlacedSections, unloadSections, restoreSection, unloadedSections } = await import("../sidebar-sections.js");
const { shownSectionSurfaces } = await import("../section-surfaces.js");
const { publish } = await import("../compositor.js");

// The surfaces of the sections are view surfaces of the plugin probe. This page has no native host, so each mount draws the
// placeholder of its surface in the body of its section (docs/spec/plugins.md#runtime-module); a surface is mounted exactly when its
// placeholder is in a body, and the placeholder element is the mounted view, which a new mount replaces.
registerPlugin({ id: "probe", name: "Probe", mark: "p", svg: "<path/>", ink: null, background: null, drop: null, surface: () => null });
const composition = { kind: "view", page: "ui/tree.html" };
// The start of each section surface that the sidebar gave to its descriptor, in the order of the descriptors.
const started = [];
const descriptor = (pluginId, section) => (surfaceId, start) => {
  started.push({ surface: surfaceId, section: start });
  return { composition: section.composition, surfaceId, pluginId,
    declarations: {}, sidecars: [], diagnostics: null, unload: false, params: null, section: start };
};
for (const section of [
  { id: "probe.tree", name: "Tree", composition, height: "fill" },
  { id: "probe.marks", name: "Marks", composition, height: 120 },
]) registerSection({ ...section, plugin: "probe", surface: descriptor("probe", section) });

const list = { id: "probe.list", title: "List", layout: "list", sections: ["probe.tree", "probe.marks"] };
const tabs = { id: "probe.tabs", title: "Tabs", layout: "tabs", sections: ["probe.tree", "probe.marks"] };

// The section surfaces of the page with the id prefix, each as {surface, section} in the order of their descriptors.
const startedSections = (prefix) => started.filter(({ surface }) => surface.startsWith(prefix));
// The view of a mounted surface: its placeholder in the body of its section, or null before its mount.
const mountedSurface = (id) => document.querySelector(`.surface-placeholder[data-surface-id="${id}"]`);
// The ids of the mounted surfaces with the prefix, in the order of the document.
const mountedIds = (prefix) => [...document.querySelectorAll(".surface-placeholder")]
  .map((view) => view.dataset.surfaceId).filter((id) => id.startsWith(prefix));
// The mount of a section is started by the sidebar after its draw; a turn of the event loop lets the placeholder be written.
const turn = () => new Promise((resolve) => setImmediate(resolve));

function sidebar() {
  const container = document.createElement("div");
  container.className = "set";
  document.getElementById("plane").append(container);
  return container;
}

test("each section body is the slot of a view surface named <space id>/<sidebar id>/<section id>", async () => {
  const container = sidebar();
  try {
    drawSet(container, "c1:left", list, { space: "spc-aaaaaa", card: "c1", surface: "t1", orientation: "vertical" });
    await turn();
    const bodies = [...container.querySelectorAll(".set__body")];
    assert.deepEqual(bodies.map((body) => body.dataset.nativeSurfaceId), ["spc-aaaaaa/c1:left/probe.tree", "spc-aaaaaa/c1:left/probe.marks"]);
    assert.deepEqual(bodies.map((body) => body.dataset.nativePlugin), ["probe", "probe"]);
    assert.ok(bodies.every((body) => body.dataset.nativeSurface !== undefined), "a section body must be a native surface slot");
    assert.deepEqual(startedSections("spc-aaaaaa/c1:"), [
      { surface: "spc-aaaaaa/c1:left/probe.tree", section: { id: "probe.tree", sidebar: "c1:left", card: "c1" } },
      { surface: "spc-aaaaaa/c1:left/probe.marks", section: { id: "probe.marks", sidebar: "c1:left", card: "c1" } },
    ]);
    assert.deepEqual(mountedIds("spc-aaaaaa/c1:"), ["spc-aaaaaa/c1:left/probe.tree", "spc-aaaaaa/c1:left/probe.marks"]);
    assert.ok(bodies.every((body) => body.querySelector(":scope > .surface-placeholder")?.dataset.surfaceId === body.dataset.nativeSurfaceId),
      "each section body must hold the view of its surface");
  } finally { clearSet(container); container.remove(); }
});

test("the same window sidebar section of two spaces gives two section surfaces with their own ids", async () => {
  // Every project window has the sidebar left, so only the space tells the two surfaces apart.
  const container = sidebar();
  try {
    const mounts = [];
    drawSet(container, "left", list, { space: "spc-aaaaaa", orientation: "vertical", window: true });
    await turn();
    mounts.push(...mountedIds("spc-aaaaaa/left/"));
    drawSet(container, "left", list, { space: "spc-bbbbbb", orientation: "vertical", window: true });
    await turn();
    mounts.push(...mountedIds("spc-bbbbbb/left/"));
    assert.deepEqual(mounts, [
      "spc-aaaaaa/left/probe.tree", "spc-aaaaaa/left/probe.marks", "spc-bbbbbb/left/probe.tree", "spc-bbbbbb/left/probe.marks",
    ]);
  } finally {
    clearSet(container);
    container.remove();
  }
});

test("a sidebar draws no section without the space of its layout", () => {
  const container = sidebar();
  try {
    assert.throws(() => drawSet(container, "left", list, { orientation: "vertical", window: true }),
      /sidebar left draws sections without the space of its layout/);
  } finally {
    container.remove();
  }
});

test("a window sidebar section starts with card null", async () => {
  const container = sidebar();
  try {
    drawSet(container, "left", list, { space: "spc-cccccc", card: null, surface: null, orientation: "vertical", window: true, plugin: null, side: "left" });
    await turn();
    assert.deepEqual(startedSections("spc-cccccc/left/").map(({ section }) => section), [
      { id: "probe.tree", sidebar: "left", card: null }, { id: "probe.marks", sidebar: "left", card: null }]);
    assert.equal(mountedIds("spc-cccccc/left/").length, 2);
  } finally { clearSet(container); container.remove(); }
});

test("folding and an unselected tab hide a section surface without releasing it", async () => {
  const listed = sidebar();
  const tabbed = sidebar();
  try {
    drawSet(listed, "c2:left", list, { space: "spc-aaaaaa", card: "c2", surface: "t2", orientation: "vertical" });
    drawSet(tabbed, "c2:right", tabs, { space: "spc-aaaaaa", card: "c2", surface: "t2", orientation: "vertical" });
    mountPlacedSections(["spc-aaaaaa/c2:right/probe.marks"]);
    await turn();
    const kept = ["spc-aaaaaa/c2:left/probe.tree", "spc-aaaaaa/c2:right/probe.marks"].map((id) => mountedSurface(id));
    foldSection("c2:left", "probe.tree");
    selectSection("c2:right", "probe.marks");
    assert.ok(kept.every((view) => view !== null), "the sections must be mounted");
    assert.ok(["spc-aaaaaa/c2:left/probe.tree", "spc-aaaaaa/c2:right/probe.marks"].every((id, index) => mountedSurface(id) === kept[index]),
      "a hidden section surface must stay mounted");
    assert.equal(mountedIds("spc-aaaaaa/c2:").length, 4, "every section of both sets must mount once");
    const tree = listed.querySelector('[data-native-surface-id="spc-aaaaaa/c2:left/probe.tree"]');
    assert.ok(tree.closest("[hidden]") || tree.hidden || tree.closest('[data-folded="true"]'), "a folded section body must be hidden");
    const unselected = tabbed.querySelector('[data-native-surface-id="spc-aaaaaa/c2:right/probe.tree"]');
    assert.ok(unselected.closest("[hidden]"), "the section of an unselected tab must be hidden");
  } finally { clearSet(listed); clearSet(tabbed); listed.remove(); tabbed.remove(); }
});

test("a hidden section mounts only when a placement holds it", async () => {
  const container = sidebar();
  try {
    drawSet(container, "c7:left", tabs, { space: "spc-aaaaaa", card: "c7", surface: "t1", orientation: "vertical" });
    await turn();
    const id = "spc-aaaaaa/c7:left/probe.marks";
    assert.deepEqual(mountedIds("spc-aaaaaa/c7:"), ["spc-aaaaaa/c7:left/probe.tree"], "only the shown section mounts at its draw");
    assert.ok(container.querySelector(`[data-native-surface][data-native-surface-id="${id}"]`), "a hidden section has a seat before its mount");
    mountPlacedSections([id, "tab-without-a-section"]);
    mountPlacedSections([id]);
    await turn();
    assert.deepEqual(mountedIds("spc-aaaaaa/c7:"), ["spc-aaaaaa/c7:left/probe.tree", id], "a placement mounts the hidden section once");
  } finally { clearSet(container); container.remove(); }
});

test("an unloaded section leaves the seats and returns to them on its show, and only the restore mounts it", async () => {
  const container = sidebar();
  try {
    drawSet(container, "c8:left", tabs, { space: "spc-aaaaaa", card: "c8", surface: "t1", orientation: "vertical" });
    const id = "spc-aaaaaa/c8:left/probe.marks";
    const seat = () => container.querySelector(`[data-native-surface][data-native-surface-id="${id}"]`);
    const reported = () => sidebarsState().find(({ sidebar }) => sidebar === "c8:left").sections.find((section) => section.id === "probe.marks");
    mountPlacedSections([id]);
    await turn();
    assert.equal(reported().mounted, true);
    // The surface of an unloaded section is released by the next commit, so its view stays until then; a new mount replaces the view.
    const view = mountedSurface(id);
    assert.ok(view !== null, "the placement must mount the section");
    unloadSections([id, "tab-without-a-section"]);
    assert.equal(reported().mounted, false, "core.sidebars must report the unloaded section without a mount");
    assert.equal(seat(), null, "an unloaded section has no seat for the compositor and the verification");
    assert.deepEqual(unloadedSections().map(({ id: unloaded, plugin }) => [unloaded, plugin]), [[id, "probe"]], "the page keeps an unloaded section a candidate");
    mountPlacedSections([id]);
    selectSection("c8:left", "probe.tree");
    await turn();
    assert.equal(mountedSurface(id), view, "neither a placement nor an apply mounts an unloaded section");
    assert.equal(seat(), null, "a hidden unloaded section stays without a seat");
    selectSection("c8:left", "probe.marks");
    assert.ok(seat(), "a shown unloaded section has a seat, which gives the memory saver its show");
    await turn();
    assert.equal(mountedSurface(id), view, "the show alone does not mount the section");
    restoreSection(id);
    await turn();
    assert.ok(mountedSurface(id) !== null && mountedSurface(id) !== view, "the restore must mount the section again");
    assert.equal(reported().mounted, true);
    assert.deepEqual(unloadedSections(), []);
  } finally { clearSet(container); container.remove(); }
});

test("a sidebar that draws an unloaded section again after its release holds a new surface", async () => {
  const container = sidebar();
  try {
    const context = { space: "spc-aaaaaa", card: "c9", surface: "t1", orientation: "vertical" };
    const id = "spc-aaaaaa/c9:left/probe.marks";
    drawSet(container, "c9:left", tabs, context);
    unloadSections([id]);
    clearSet(container);
    assert.deepEqual(unloadedSections(), [], "a released section is no candidate of the page");
    drawSet(container, "c9:left", tabs, context);
    mountPlacedSections([id]);
    await turn();
    assert.ok(mountedSurface(id) !== null);
    assert.ok(container.querySelector(`[data-native-surface][data-native-surface-id="${id}"]`));
  } finally { clearSet(container); container.remove(); }
});

test("a change of the active tab keeps the section surfaces and core.sidebars reports the followed surface", async () => {
  const container = sidebar();
  try {
    drawSet(container, "c3:left", list, { space: "spc-aaaaaa", card: "c3", surface: "t1", orientation: "vertical" });
    await turn();
    const entries = ["spc-aaaaaa/c3:left/probe.tree", "spc-aaaaaa/c3:left/probe.marks"].map((id) => mountedSurface(id));
    drawSet(container, "c3:left", list, { space: "spc-aaaaaa", card: "c3", surface: "t2", orientation: "vertical" });
    await turn();
    assert.ok(entries.every((view) => view !== null), "the sections must be mounted");
    assert.ok(["spc-aaaaaa/c3:left/probe.tree", "spc-aaaaaa/c3:left/probe.marks"].every((id, index) => mountedSurface(id) === entries[index]),
      "a change of the followed tab must not mount the sections again");
    assert.equal(mountedIds("spc-aaaaaa/c3:").length, 2);
    const state = sidebarsState().find((entry) => entry.sidebar === "c3:left");
    assert.deepEqual(state.sections.map(({ id, surfaceId, surface }) => ({ id, surfaceId, surface })), [
      { id: "probe.tree", surfaceId: "spc-aaaaaa/c3:left/probe.tree", surface: "t2" },
      { id: "probe.marks", surfaceId: "spc-aaaaaa/c3:left/probe.marks", surface: "t2" },
    ]);
  } finally { clearSet(container); container.remove(); }
});

test("a drawn set records its section surfaces as shown, and clearing it leaves their release to the commit", async () => {
  const container = sidebar();
  drawSet(container, "c4:left", list, { space: "spc-aaaaaa", card: "c4", surface: null, orientation: "vertical" });
  await turn();
  assert.deepEqual(shownSectionSurfaces().filter((id) => id.startsWith("spc-aaaaaa/c4:")), ["spc-aaaaaa/c4:left/probe.tree", "spc-aaaaaa/c4:left/probe.marks"]);
  const bodies = [...container.querySelectorAll(".set__body")];
  // The compositor takes the descriptor of each slot of the plane for a commit.
  publish();
  const viewOf = (body) => body.querySelector(":scope > .surface-placeholder");
  const kept = bodies.map(viewOf);
  assert.ok(kept.every((view) => view !== null), "each section body must hold the view of its surface");
  clearSet(container);
  container.remove();
  assert.deepEqual(shownSectionSurfaces().filter((id) => id.startsWith("spc-aaaaaa/c4:")), []);
  // A body that is put back into the plane has no descriptor, which the compositor reports for the slot.
  const plane = document.getElementById("plane");
  plane.append(...bodies);
  try {
    assert.throws(() => publish(), /surface slot spc-aaaaaa\/c4:left\/probe\.tree has no current descriptor/, "a cleared section body must hold no surface descriptor");
  } finally { for (const body of bodies) body.remove(); }
  // A commit that no longer holds the surface releases it, as it releases the surface of a closed tab (docs/spec/plugins.md#sections).
  assert.ok(bodies.every((body, index) => viewOf(body) === kept[index]), "clearing the set must leave the views to the commit");
});

test("a section has its declared height and a fill section shares the remaining height", () => {
  const container = sidebar();
  try {
    drawSet(container, "c5:left", list, { space: "spc-aaaaaa", card: "c5", surface: null, orientation: "vertical" });
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
      assert.throws(() => drawSet(container, "invalid-mode", set, { space: "spc-aaaaaa", card: "card", surface: null, orientation }),
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
