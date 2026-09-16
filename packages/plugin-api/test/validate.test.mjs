import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_IMPORTS, checkReferences, modulePath, pageImports, validateEnvironment, validateManifest,
} from "../index.js";

const card = { id: "probe", name: "Probe", mark: "p", icon: "<path/>", surface: { page: "ui/probe.html" } };
const side = { id: "side", name: "Side", sections: [{ id: "side.list", name: "List" }] };
const environment = () => ({
  runtime: "runtime",
  plugins: ["@scope/plugin-probe", "plugin-side"],
  workspace: {
    focus: "main",
    grid: {
      xs: [0, 0.2, 1], ys: [0, 1],
      cards: [
        { id: "left", c0: 0, c1: 1, r0: 0, r1: 1, width: 190, fixed: true },
        { id: "main", c0: 1, c1: 2, r0: 0, r1: 1, tabs: [{ plugin: "probe", title: "p 1" }] },
      ],
    },
  },
  sidebars: {
    sets: [{ id: "set-side", title: "Side", sections: ["side.list"] }],
    links: [{ place: "left", plugin: null, set: "set-side" }, { place: "right", plugin: "probe", set: "set-side" }],
  },
});

test("a manifest with a page surface or with sections only is accepted", () => {
  assert.equal(validateManifest(card), card);
  assert.equal(validateManifest(side), side);
  assert.equal(validateManifest({ ...card, surface: { url: "https://example.com" } }).id, "probe");
});

test("a manifest is rejected for each invalid field", () => {
  const cases = [
    [{ ...card, id: "Probe" }, /invalid id/],
    [{ ...card, name: "" }, /name is required/],
    [{ ...card, extra: 1 }, /unknown field extra/],
    [{ ...card, surface: { url: "https://a", page: "b" } }, /exactly one/],
    [{ ...card, surface: { url: "file:///etc" } }, /http or https/],
    [{ ...card, surface: { page: "../x.html" } }, /inside the package/],
    [{ ...card, surface: { page: "/x.html" } }, /inside the package/],
    [{ ...card, mark: undefined }, /mark is required/],
    [{ ...card, icon: undefined }, /icon is required/],
    [{ ...side, sections: [{ id: "other.list", name: "x" }] }, /must be side.<name>/],
    [{ ...side, sections: [side.sections[0], side.sections[0]] }, /duplicate section/],
    [{ id: "empty", name: "Empty" }, /surface or sections/],
  ];
  for (const [manifest, message] of cases) assert.throws(() => validateManifest(manifest), message);
});

test("an environment is accepted and its references are checked against manifests", () => {
  const value = environment();
  assert.equal(validateEnvironment(value), value);
  checkReferences(value, [card, side]);
});

test("an environment is rejected for each invalid field", () => {
  const cases = [
    [(e) => { e.runtime = "../runtime"; }, /runtime must be a directory/],
    [(e) => { e.plugins.push("plugin-side"); }, /duplicate plugin package/],
    [(e) => { e.plugins = ["Bad Name"]; }, /package names/],
    [(e) => { e.workspace.focus = "left"; }, /focus must name a card with tabs/],
    [(e) => { e.workspace.grid.cards[1].tabs = []; }, /non-empty array/],
    [(e) => { e.sidebars.links[0].set = "missing"; }, /known set/],
    [(e) => { e.sidebars.links[1].plugin = null; }, /plugin null/],
    [(e) => { e.sidebars.sets.push(e.sidebars.sets[0]); }, /duplicate set/],
  ];
  for (const [change, message] of cases) {
    const value = environment();
    change(value);
    assert.throws(() => validateEnvironment(value), message);
  }
});

test("references to missing plugins and sections are rejected", () => {
  const cases = [
    [(e) => { e.workspace.grid.cards[1].tabs[0].plugin = "side"; }, /tab plugin side has no surface/],
    [(e) => { e.sidebars.sets[0].sections.push("side.missing"); }, /unknown section side.missing/],
    [(e) => { e.sidebars.links[1].plugin = "side"; }, /link names plugin side/],
  ];
  for (const [change, message] of cases) {
    const value = environment();
    change(value);
    assert.throws(() => checkReferences(value, [card, side]), message);
  }
  assert.throws(() => checkReferences(environment(), [card, side, { ...side }]), /same id/);
});

test("page imports resolve inside the staged layout", () => {
  assert.equal(PAGE_IMPORTS["soksak"], "/modules/soksak/dist/index.js");
  assert.equal(PAGE_IMPORTS["@soksak/runtime"], "/runtime/index.js");
  assert.equal(modulePath("@scope/name", "ui/page.html"), "modules/@scope/name/ui/page.html");
  assert.throws(() => { PAGE_IMPORTS.extra = "/x.js"; }, TypeError);
});

test("a page's import map is read only when the page declares exactly one", () => {
  const map = `<script type="importmap">\n${JSON.stringify({ imports: PAGE_IMPORTS })}\n</script>`;
  assert.deepEqual(pageImports(`<title>x</title>${map}<script type="module"></script>`), { ...PAGE_IMPORTS });
  assert.throws(() => pageImports("<title>x</title>"), /found 0/);
  assert.throws(() => pageImports(map + map), /found 2/);
});
