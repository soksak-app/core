import assert from "node:assert/strict";
import test from "node:test";
import { checkSidebarReferences, normalizeSidebarDefaults, validateManifest, validateSidebars } from "../index.js";

const manifests = () => [
  { id: "pane", name: "Pane", description: "Content fixture.", mark: "p", icon: "<path/>",
    surface: { module: "ui/pane.js", composition: { kind: "dom" } },
    sections: [{ id: "pane.info", name: "Info", module: "ui/info.js" }],
    sidebars: { sets: [{ id: "info", title: "Info", sections: ["pane.info", "tree.list"], layout: "list" }],
      card: { top: "info", bottom: "info", left: "info", right: "info" }, window: { left: "info", right: "info" } } },
  { id: "tree", name: "Tree", description: "Section-only fixture.",
    sections: [{ id: "tree.list", name: "Tree", module: "ui/tree.js" }],
    sidebars: { sets: [{ id: "tree", title: "Tree", sections: ["tree.list"], layout: "tabs" }], window: { left: "tree" } } },
];

const sidebars = (links) => ({ sets: [{ id: "set-1", title: "Info", sections: [], layout: "list" }], links });

test("window defaults coexist with every internal card side and section-only plugins", () => {
  for (const manifest of manifests()) assert.equal(validateManifest(manifest), manifest);
});

test("window normalization retains every plugin on a shared side without mutating declarations", () => {
  const all = manifests();
  const before = structuredClone(all);
  assert.deepEqual(normalizeSidebarDefaults({}, all), {
    sets: [
      { ...all[0].sidebars.sets[0], id: "pane.info" },
      { ...all[1].sidebars.sets[0], id: "tree.tree" },
    ],
    links: [
      ...["top", "bottom", "left", "right"].map((side) => ({ place: `card-${side}`, plugin: "pane", set: "pane.info" })),
      { place: "window-left", plugin: "pane", set: "pane.info" },
      { place: "window-right", plugin: "pane", set: "pane.info" },
      { place: "window-left", plugin: "tree", set: "tree.tree" },
    ],
  });
  assert.deepEqual(all, before);
});

test("explicit environment lists replace all window defaults including empty lists", () => {
  const replacement = sidebars([{ place: "window-right", plugin: "tree", set: "set-1" }]);
  assert.deepEqual(normalizeSidebarDefaults({ sidebars: replacement }, manifests()), replacement);
  assert.deepEqual(normalizeSidebarDefaults({ sidebars: { sets: [], links: [] } }, manifests()), { sets: [], links: [] });
});

test("window default mappings reject invalid shapes, unknown sides, and missing local sets", () => {
  for (const [value, message] of [
    [null, /window defaults must be an object/],
    [[], /window defaults must be an object/],
    ["left", /window defaults must be an object/],
    [{ top: "info" }, /top/],
    [{ left: "missing" }, /window left names unknown set missing/],
    [{ right: null }, /window right names unknown set null/],
    [{ left: "pane.info" }, /window left names unknown set pane.info/],
  ]) {
    const manifest = manifests()[0];
    manifest.sidebars.window = value;
    assert.throws(() => validateManifest(manifest), message);
  }
});

test("replaced window declarations still reject invalid local sets and uninstalled sections", () => {
  const all = manifests();
  all[0].sidebars.window.left = "missing";
  assert.throws(() => normalizeSidebarDefaults({ sidebars: { sets: [], links: [] } }, all), /window left names unknown set missing/);
  all[0].sidebars.window.left = "info";
  all[1].sidebars.sets[0].sections.push("missing.section");
  assert.throws(() => normalizeSidebarDefaults({ sidebars: { sets: [], links: [] } }, all), /unknown section missing.section/);
});

test("new window links require a plugin and a known set and reject duplicate choices", () => {
  const link = { place: "window-left", plugin: "tree", set: "set-1" };
  assert.doesNotThrow(() => validateSidebars(sidebars([link]), "settings"));
  for (const [links, message] of [
    [[{ ...link, plugin: null }], /window-left link names a plugin/],
    [[{ ...link, set: null }], /window-left link requires a known set/],
    [[{ ...link, set: "missing" }], /known set/],
    [[link, { ...link }], /link window-left tree appears twice/],
    [[{ ...link, place: "window-top" }], /requires a place/],
  ]) assert.throws(() => validateSidebars(sidebars(links), "settings"), message);
});

test("window references accept section-only plugins but card references still require surfaces", () => {
  const all = manifests();
  const links = sidebars([{ place: "window-right", plugin: "tree", set: "set-1" }]);
  assert.doesNotThrow(() => checkSidebarReferences(links, all, "settings"));
  assert.throws(() => checkSidebarReferences(sidebars([{ place: "card-left", plugin: "tree", set: "set-1" }]), all, "settings"), /plugin tree without a surface/);
  assert.throws(() => checkSidebarReferences(sidebars([{ place: "window-left", plugin: "missing", set: "set-1" }]), all, "settings"), /unknown plugin missing/);
});
