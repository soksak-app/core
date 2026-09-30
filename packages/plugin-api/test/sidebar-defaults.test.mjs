import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../index.js";

const manifests = () => [
  { id: "card", name: "Card", description: "Fixture card.", mark: "c", icon: "<path/>",
    surface: { module: "ui/card.js", composition: { kind: "dom" } },
    sections: [{ id: "card.info", name: "Info", module: "ui/info.js" }],
    sidebars: { sets: [{ id: "main", title: "Main", sections: ["card.info", "other.tree"], layout: "list" }],
      card: { top: "main", bottom: "main", left: "main", right: "main" } } },
  { id: "other", name: "Other", description: "Fixture sections.",
    sections: [{ id: "other.tree", name: "Tree", module: "ui/tree.js" }],
    sidebars: { sets: [{ id: "main", title: "Tree", sections: ["other.tree"], layout: "tabs" }] } },
];

test("plugins declare local sidebar sets and four card defaults", () => {
  for (const manifest of manifests()) assert.equal(api.validateManifest(manifest), manifest);
});

test("sidebar defaults normalize plugin namespaces and preserve section order", () => {
  const all = manifests();
  const before = structuredClone(all);
  assert.deepEqual(api.normalizeSidebarDefaults({}, all), {
    sets: [
      { id: "card.main", title: "Main", sections: ["card.info", "other.tree"], layout: "list" },
      { id: "other.main", title: "Tree", sections: ["other.tree"], layout: "tabs" },
    ],
    links: ["top", "bottom", "left", "right"].map((side) => ({ place: `card-${side}`, plugin: "card", set: "card.main" })),
  });
  assert.deepEqual(all, before, "normalization mutated plugin declarations");
});

test("an explicit environment list replaces defaults including empty lists", () => {
  const sidebars = { sets: [], links: [] };
  assert.deepEqual(api.normalizeSidebarDefaults({ sidebars }, manifests()), sidebars);
});

test("invalid plugin defaults fail even when an environment override removes them", () => {
  const all = manifests();
  all[0].sidebars.sets[0].sections.push("missing.tree");
  assert.throws(() => api.normalizeSidebarDefaults({ sidebars: { sets: [], links: [] } }, all), /unknown section missing.tree/);
});

test("plugin defaults reject malformed IDs, fields, layouts, and side references", () => {
  for (const [edit, message] of [
    [(m) => { m.sidebars = null; }, /sidebars must be an object/],
    [(m) => { m.sidebars.sets = {}; }, /requires sets and links/],
    [(m) => { m.sidebars.card = []; }, /card defaults must be an object/],
    [(m) => { m.sidebars.card.middle = "main"; }, /middle/],
    [(m) => { m.sidebars.card.top = "missing"; }, /unknown set missing/],
    [(m) => { m.sidebars.card.top = null; }, /unknown set null/],
    [(m) => { m.sidebars.sets[0].id = "card.main"; }, /local set id/],
    [(m) => { m.sidebars.sets[0].id = "off"; }, /reserved/],
    [(m) => { m.sidebars.sets.push(structuredClone(m.sidebars.sets[0])); }, /duplicate set/],
    [(m) => { m.sidebars.sets[0].layout = "grid"; }, /list or tabs/],
    [(m) => { delete m.surface; delete m.mark; delete m.icon; }, /card defaults require a surface/],
  ]) {
    const manifest = manifests()[0];
    edit(manifest);
    assert.throws(() => api.validateManifest(manifest), message);
  }
});
