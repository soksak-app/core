import assert from "node:assert/strict";
import test from "node:test";
import { retainedSurfaceEntries, storedSpaceTabs, surfaceKindOf } from "../surface-listing.js";

test("a mounted view outside the seated record is listed with its exposes and no placement", () => {
  const mounts = [
    { surface: "tab-a", plugin: "probeview", exposes: ["status core.surface.document", "status probeview.location"], composition: "view",
      status: { phase: "ready", error: null }, state: "loaded", kind: "tab", sidebar: null },
    { surface: "tab-b", plugin: "probeview", exposes: ["status probeview.location"], composition: "view",
      status: { phase: "ready", error: null }, state: "loaded", kind: "tab", sidebar: null },
  ];
  assert.deepEqual(retainedSurfaceEntries(mounts, new Set(["tab-b"])), [{
    surface: "tab-a", plugin: "probeview", visible: false, dim: null, declared: null, applied: null,
    exposes: ["status core.surface.document", "status probeview.location"], status: { phase: "ready", error: null },
    placeholder: null, composition: "view", state: "loaded", kind: "tab", sidebar: null,
  }]);
});

test("a mount of another composition outside the seated record is not listed", () => {
  const mounts = [
    { surface: "tab-dom", plugin: "notes", exposes: ["status notes.text"], composition: "dom",
      status: { phase: "ready", error: null }, state: "loaded" },
    { surface: "tab-none", plugin: "notes", exposes: [], composition: null,
      status: { phase: "ready", error: null }, state: "loaded" },
  ];
  assert.deepEqual(retainedSurfaceEntries(mounts, new Set()), []);
});

test("the retained entries reject a mount list or a seated set of another type", () => {
  assert.throws(() => retainedSurfaceEntries(null, new Set()), TypeError);
  assert.throws(() => retainedSurfaceEntries([], ["tab-a"]), TypeError);
});

test("a section surface is listed with kind section and its sidebar, and a tab surface with kind tab", () => {
  assert.deepEqual(surfaceKindOf({ surfaceId: "spc-aaaaaa/c3:right/probe.dom", section: { id: "probe.dom", sidebar: "c3:right", card: "c3" } }),
    { kind: "section", sidebar: "c3:right" });
  assert.deepEqual(surfaceKindOf({ surfaceId: "tab-a", section: null }), { kind: "tab", sidebar: null });
  assert.deepEqual(surfaceKindOf({ surfaceId: "tab-b" }), { kind: "tab", sidebar: null });
});

test("a retained section view keeps its kind and sidebar", () => {
  const mounts = [{ surface: "spc-aaaaaa/left/probe.tree", plugin: "probe", exposes: [], composition: "view",
    status: { phase: "ready", error: null }, state: "loaded", kind: "section", sidebar: "left" }];
  const [entry] = retainedSurfaceEntries(mounts, new Set());
  assert.equal(entry.kind, "section");
  assert.equal(entry.sidebar, "left");
});

// The stored layout of a space holds its cards as a tree (docs/spec/workspace.md), so the tabs of a group card nested in a cut are listed.
test("the tabs of the stored layouts of other spaces are read from the layout tree", () => {
  const tab = (id) => ({ id, plugin: "probeview", title: id });
  const content = (card, tabs) => ({ card, data: { tabs, activeId: tabs[0].id } });
  const layout = (root) => ({ focusedId: "c1", named: 0, windowSidebars: {}, sidebars: {}, leader: "c1", lastCard: 2, state: { root } });
  const projects = [
    { id: "prj-a", spaces: [
      { id: "spc-a", layout: layout(content("c1", [tab("tab-current")])) },
      { id: "spc-b", layout: layout({ cut: "x", kids: [{ share: 1, node: content("c1", [tab("tab-1"), tab("tab-2")]) },
        { share: 1, node: content("c2", [tab("tab-3")]) }] }) },
    ] },
  ];
  const listed = storedSpaceTabs(projects, (project, space) => space.id === "spc-a");
  assert.deepEqual(listed.map(({ tab, card, holder }) => [tab.id, card.id, holder]), [
    ["tab-1", "c1", "the stored layout of space spc-b, project prj-a"],
    ["tab-2", "c1", "the stored layout of space spc-b, project prj-a"],
    ["tab-3", "c2", "the stored layout of space spc-b, project prj-a"],
  ]);
});
