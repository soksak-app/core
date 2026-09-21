import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_IMPORTS, checkReferences, modulePath, pageImports, validateEnvironment, validateManifest, validateSidecar,
} from "../index.js";

const card = {
  id: "probe", name: "Probe", mark: "p", icon: "<path/>",
  surface: { module: "ui/probe.js", composition: { kind: "dom" } }, sidecars: ["@scope/sidecar-worker"],
};
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
  assert.equal(validateManifest({ ...card, preview: { ink: "--surface-fg" } }).preview.ink, "--surface-fg");
  assert.equal(validateManifest({ ...card, home: "https://example.com/start" }).home, "https://example.com/start");
  const background = { sidecar: "@scope/sidecar-worker", operation: "open" };
  assert.equal(validateManifest({ ...card, background }).background.operation, "open");
});

test("a manifest is rejected for each invalid field", () => {
  const cases = [
    [{ ...card, id: "Probe" }, /invalid id/],
    [{ ...card, name: "" }, /name is required/],
    [{ ...card, extra: 1 }, /unknown field extra/],
    [{ ...card, surface: { url: "https://a" } }, /unknown field url/],
    [{ ...card, surface: { url: "https://a", module: "b.js", composition: { kind: "dom" } } }, /unknown field url/],
    [{ ...card, surface: {} }, /surface requires a module/],
    [{ ...card, surface: { module: "ui/probe.js" } }, /surface requires a composition/],
    [{ ...card, home: "file:///etc" }, /home must be an http or https address/],
    [{ ...card, home: "https:///" }, /home must be an http or https address/],
    [{ ...side, home: "https://example.com" }, /home requires a surface/],
    [{ ...card, surface: { module: "../x.js", composition: { kind: "dom" } } }, /inside the package/],
    [{ ...card, surface: { module: "/x.js", composition: { kind: "dom" } } }, /inside the package/],
    [{ ...card, mark: undefined }, /mark is required/],
    [{ ...card, icon: undefined }, /icon is required/],
    [{ ...side, sections: [{ id: "other.list", name: "x" }] }, /must be side.<name>/],
    [{ ...side, sections: [side.sections[0], side.sections[0]] }, /duplicate section/],
    [{ id: "empty", name: "Empty" }, /surface or sections/],
    [{ ...side, sidecars: ["@scope/sidecar-worker"] }, /sidecars require a surface/],
    [{ ...card, sidecars: ["Worker"] }, /expected sidecar package names/],
    [{ ...card, preview: { ink: "red" } }, /preview.ink must be a theme token/],
    [{ ...card, preview: { ink: "--rail", fill: "--bg" } }, /unknown field fill/],
    [{ ...side, preview: { ink: "--rail" } }, /preview requires a surface/],
    [{ ...card, sidecars: ["@scope/sidecar-worker", "@scope/sidecar-worker"] }, /duplicate sidecar/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker", open: { op: "open" } } }, /unknown field open/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker" } }, /operation must be a non-empty string/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker", operation: "" } }, /operation must be a non-empty string/],
    [{ ...card, background: { sidecar: "@scope/sidecar-other", operation: "open" } }, /sidecar must be declared/],
  ];
  for (const [manifest, message] of cases) assert.throws(() => validateManifest(manifest), message);
});

test("surface composition declarations are complete and fail closed", () => {
  const documentRegion = { name: "page", kind: "document", input: "native" };
  const imageRegion = {
    name: "view", kind: "image", sidecar: "@scope/sidecar-worker", input: "dom",
  };
  const hybrid = (regions = [documentRegion], overlays = []) => ({
    ...card, surface: { module: "ui/probe.js", composition: { kind: "hybrid", regions, overlays } },
  });
  assert.equal(validateManifest(hybrid()).surface.composition.kind, "hybrid");
  assert.equal(validateManifest(hybrid([imageRegion])).surface.composition.regions[0].sidecar, "@scope/sidecar-worker");

  const cases = [
    [{ ...card, surface: { ...card.surface, composition: { kind: "other" } } }, /kind must be dom or hybrid/],
    [{ ...card, surface: { ...card.surface, composition: { kind: "dom", regions: [] } } }, /unknown field regions/],
    [hybrid([]), /requires regions/],
    [{ ...hybrid(), surface: { ...hybrid().surface, composition: { kind: "hybrid", regions: [documentRegion] } } }, /requires overlays/],
    [hybrid([{ ...documentRegion, input: "dom" }]), /document input must be native/],
    [hybrid([{ ...imageRegion, input: "native" }]), /image input must be dom/],
    [hybrid([{ ...imageRegion, sidecar: "@scope/sidecar-other" }]), /sidecar must be declared/],
    [hybrid([{ ...imageRegion, fallback: "--surface" }]), /unknown field fallback/],
    [hybrid([{ ...documentRegion, extra: true }]), /unknown field extra/],
    [hybrid([documentRegion, { ...documentRegion }]), /duplicate name page/],
    [hybrid([documentRegion], ["page"]), /duplicate name page/],
    [hybrid([documentRegion], ["Bad Name"]), /invalid overlay name/],
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

test("an environment has no sidecar field", () => {
  assert.throws(() => validateEnvironment({ ...environment(), sidecars: ["@scope/sidecar-worker"] }), /unknown field sidecars/);
});

test("a sidecar manifest names an executable inside its package and a protocol version", () => {
  const sidecar = { executable: "build/worker", protocol: 1 };
  assert.equal(validateSidecar(sidecar), sidecar);
  const cases = [
    [{ ...sidecar, name: "worker" }, /unknown field name/],
    [{ ...sidecar, executable: "../worker" }, /executable must be a path inside the package/],
    [{ ...sidecar, executable: "/bin/sh" }, /executable must be a path inside the package/],
    [{ ...sidecar, protocol: 2 }, /protocol must be 1/],
    [[], /expected an object/],
  ];
  for (const [value, message] of cases) assert.throws(() => validateSidecar(value), message);
});

test("a persistent sidecar declares its transport explicitly", () => {
  const declaration = { executable: "build/worker", protocol: 1, transport: "persistent" };
  assert.equal(validateSidecar(declaration), declaration);
  for (const transport of [null, "tcp", "stdio", 1]) {
    assert.throws(() => validateSidecar({ ...declaration, transport }), /transport must be persistent/);
  }
});

test("a sidecar manifest may include optional helpers field with package and executable", () => {
  const base = { executable: "build/worker", protocol: 1 };
  const withHelpers = {
    ...base,
    helpers: [
      { package: "@scope/helper", executable: "build/ptyd" },
      { package: "lib-shared", executable: "dist/helper" },
    ],
  };
  assert.equal(validateSidecar(withHelpers), withHelpers);
});

test("a sidecar helpers field is rejected for invalid cases", () => {
  const base = { executable: "build/worker", protocol: 1 };
  const cases = [
    [{ ...base, helpers: [{ package: "@scope/helper", executable: "build/ptyd", extra: "field" }] }, /unknown field extra/],
    [{ ...base, helpers: [{ package: "lib-shared" }] }, /executable must be a path inside the package/],
    [{ ...base, helpers: [{ executable: "build/helper" }] }, /package must be a package name/],
    [{ ...base, helpers: [{ package: "Bad Name", executable: "build/helper" }] }, /package must be a package name/],
    [{ ...base, helpers: [{ package: "lib-shared", executable: "/bin/helper" }] }, /must be a path inside the package/],
    [{ ...base, helpers: [{ package: "lib-shared", executable: "../helper" }] }, /must be a path inside the package/],
    [{ ...base, helpers: [
      { package: "@scope/helper", executable: "build/ptyd" },
      { package: "lib-shared", executable: "build/ptyd" },
    ] }, /ptyd is declared twice/],
    [{ ...base, helpers: [{ package: "lib-shared", executable: "dist/worker" }] }, /worker is declared twice/],
  ];
  for (const [value, message] of cases) assert.throws(() => validateSidecar(value), message);
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
