import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_IMPORTS, checkReferences, checkSidebarReferences, modulePath, pageImports, validateEnvironment, validateManifest,
  validateSidebars, validateSidecar,
} from "../index.js";

const card = {
  id: "probe", name: "Probe", description: "검사용 표면.", mark: "p", icon: "<path/>",
  surface: { module: "ui/probe.js", composition: { kind: "dom" } }, dependencies: { "@scope/sidecar-worker": "^1.2.0" },
  settings: { "cursor.shape": { type: "enum", label: "커서 모양", default: "block", values: ["block", "beam"] } },
};
const side = { id: "side", name: "Side", description: "검사용 섹션.", sections: [{ id: "side.list", name: "List", module: "ui/list.js" }] };
const environment = () => ({
  runtime: "runtime",
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
    sets: [{ id: "set-side", title: "Side", sections: ["side.list"], layout: "list" }],
    links: [{ place: "left", plugin: null, set: "set-side" }, { place: "window-right", plugin: "probe", set: "set-side" }],
  },
  settings: { probe: { "cursor.shape": "block" } },
});

test("a manifest with a page surface or with sections only is accepted", () => {
  assert.equal(validateManifest(card), card);
  assert.equal(validateManifest(side), side);
  assert.equal(validateManifest({ ...side, sections: [{ ...side.sections[0], fill: true }] }).sections[0].fill, true);
  assert.equal(validateManifest({ ...card, preview: { ink: "--surface-fg" } }).preview.ink, "--surface-fg");
  // 범위는 sok 과 같은 형식이다: `*`, 하한만 있는 `>=x.y.z`, 상한이 있는 `>=x.y.z <a.b.c`(docs/spec/installation.md).
  for (const range of ["*", ">=0.0.6", ">=0.0.2 <0.1.0", "^1.2.0", "~1.2.0", "1.2.0"]) {
    assert.equal(validateManifest({ ...card, dependencies: { "@scope/sidecar-worker": range } }).dependencies["@scope/sidecar-worker"], range);
  }
  const address = (value) => ({ ...card, settings: { home: { label: "홈 주소", type: "address", default: value } } });
  assert.equal(validateManifest(address("")).settings.home.default, "");
  assert.equal(validateManifest(address("https://example.com/start")).settings.home.default, "https://example.com/start");
  assert.deepEqual(validateManifest(card).settings["cursor.shape"].values, ["block", "beam"]);
  const background = { sidecar: "@scope/sidecar-worker", operation: "open" };
  assert.equal(validateManifest({ ...card, background }).background.operation, "open");
  const withSettings = { ...background, settings: { shape: "cursor.shape" } };
  assert.deepEqual(validateManifest({ ...card, background: withSettings }).background.settings, { shape: "cursor.shape" });
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
    [{ ...card, home: "https://example.com" }, /unknown field home/],
    [{ ...card, settings: { home: { label: "홈 주소", type: "address", default: "file:///etc" } } }, /address default/],
    [{ ...card, settings: { home: { label: "홈 주소", type: "address", default: "https:///" } } }, /address default/],
    [{ ...card, settings: { home: { label: "홈 주소", type: "address", default: "", maxLength: 9 } } }, /unknown field maxLength/],
    [{ ...card, surface: { module: "../x.js", composition: { kind: "dom" } } }, /inside the package/],
    [{ ...card, surface: { module: "/x.js", composition: { kind: "dom" } } }, /inside the package/],
    [{ ...card, mark: undefined }, /mark is required/],
    [{ ...card, icon: undefined }, /icon is required/],
    [{ ...side, sections: [{ id: "other.list", name: "x" }] }, /must be side.<name>/],
    [{ ...side, sections: [side.sections[0], side.sections[0]] }, /duplicate section/],
    [{ ...side, sections: [{ id: "side.list", name: "List" }] }, /section side.list requires a module/],
    [{ ...side, sections: [{ ...side.sections[0], fill: "yes" }] }, /section side.list fill must be a boolean/],
    [{ ...side, sections: [{ id: "side.list", name: "List", module: "../list.js" }] }, /section side.list module must be a JavaScript path inside the package/],
    [{ ...side, sections: [{ id: "side.list", name: "List", module: "ui/list.css" }] }, /section side.list module must be a JavaScript path inside the package/],
    [{ id: "empty", name: "Empty", description: "빈 플러그인." }, /surface, sections or contributes/],
    [{ ...side, dependencies: { "@scope/sidecar-worker": "^1.2.0" } }, /dependencies require a surface, a state module or contributes/],
    [{ ...card, dependencies: { Worker: "^1.2.0" } }, /dependencies: Worker is not a sidecar package name/],
    [{ ...card, dependencies: ["@scope/sidecar-worker"] }, /dependencies must map sidecar packages to version ranges/],
    [{ ...card, dependencies: { "@scope/sidecar-worker": "**" } }, /dependencies @scope\/sidecar-worker: invalid range \*\*/],
    [{ ...card, dependencies: { "@scope/sidecar-worker": ">=" } }, /invalid range >=/],
    [{ ...card, dependencies: { "@scope/sidecar-worker": ">=0.0" } }, /invalid range >=0.0/],
    [{ ...card, dependencies: { "@scope/sidecar-worker": "^1.02.0" } }, /invalid range \^1.02.0/],
    [{ ...card, dependencies: { "@scope/sidecar-worker": ">=2.0.0 <1.0.0" } }, /invalid range >=2.0.0 <1.0.0/],
    [{ ...card, sidecars: ["@scope/sidecar-worker"] }, /unknown field sidecars/],
    [{ ...card, preview: { ink: "red" } }, /preview.ink must be a theme token/],
    [{ ...card, preview: { ink: "--rail", fill: "--bg" } }, /unknown field fill/],
    [{ ...side, preview: { ink: "--rail" } }, /preview requires a surface/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker", open: { operation: "open" } } }, /unknown field open/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker" } }, /operation must be a non-empty string/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker", operation: "" } }, /operation must be a non-empty string/],
    [{ ...card, background: { sidecar: "@scope/sidecar-other", operation: "open" } }, /sidecar must be declared/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker", operation: "open", settings: [] } }, /settings must map request fields/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker", operation: "open", settings: { program: "absent" } } }, /setting absent is not declared/],
    [{ ...card, background: { sidecar: "@scope/sidecar-worker", operation: "open", settings: { operation: "cursor.shape" } } }, /cannot replace operation/],
    [{ ...card, settings: { "cursor.shape": { label: "이름", type: "enum", default: "block", values: ["block", "block"] } } }, /distinct/],
    [{ ...card, settings: { "cursor.shape": { label: "이름", type: "integer", default: 1, minimum: 2, maximum: 3 } } }, /default and bounds/],
    [{ ...card, settings: { "font.family": { label: "이름", type: "string", default: "", maxLength: 8 } } }, /string default and maxLength/],
    [{ ...card, settings: { "font.family": { label: "이름", type: "string", default: "too long", maxLength: 3 } } }, /string default and maxLength/],
    [{ ...card, settings: { "font.family": { label: "글꼴", type: "string", default: "Mono", maxLength: 0 } } }, /string default and maxLength/],
    [{ ...card, settings: { "font.family": { label: "글꼴", type: "string", default: "Mono", maxLength: 8, values: [] } } }, /unknown field values/],
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
    [(e) => { e.plugins = ["@scope/plugin-probe"]; }, /unknown field plugins/],
    [(e) => { e.workspace.focus = "left"; }, /focus must name a card with tabs/],
    [(e) => { e.workspace.grid.cards[1].tabs = []; }, /non-empty array/],
    [(e) => { e.sidebars.links[0].set = "missing"; }, /known set/],
    [(e) => { e.sidebars.links[0].set = null; }, /known set/],
    [(e) => { e.sidebars.sets.push(e.sidebars.sets[0]); }, /duplicate set/],
    [(e) => { delete e.sidebars.sets[0].layout; }, /set set-side layout must be list or tabs/],
    [(e) => { e.sidebars.sets[0].layout = "grid"; }, /set set-side layout must be list or tabs/],
    [(e) => { e.workspace.grid.cards[0].width = "190"; }, /width must be a finite positive number/],
    [(e) => { e.workspace.grid.cards[0].width = 0; }, /width must be a finite positive number/],
    [(e) => { e.workspace.grid.cards[0].width = -190; }, /width must be a finite positive number/],
    [(e) => { e.workspace.grid.cards[0].width = Infinity; }, /width must be a finite positive number/],
  ];
  for (const [change, message] of cases) {
    const value = environment();
    change(value);
    assert.throws(() => validateEnvironment(value), message);
  }
});

test("environment setting values are checked against the owning manifest", () => {
  const value = environment();
  value.settings.probe["cursor.shape"] = "underline";
  assert.throws(() => checkReferences(value, [card, side]), /not declared/);
});

test("references to missing sections, surfaceless tabs and repeated ids are rejected", () => {
  const cases = [
    [(e) => { e.workspace.grid.cards[1].tabs[0].plugin = "side"; }, /tab plugin side has no surface/],
    [(e) => { e.sidebars.sets[0].sections.push("side.missing"); }, /unknown section side.missing/],
  ];
  for (const [change, message] of cases) {
    const value = environment();
    change(value);
    assert.throws(() => checkReferences(value, [card, side]), message);
  }
  assert.throws(() => checkReferences(environment(), [card, side, { ...side }]), /same id/);
});

test("an environment does not list sidecars; plugins declare them", () => {
  assert.throws(() => validateEnvironment({ ...environment(), sidecars: ["@scope/sidecar-worker"] }), /sidecars must be true or false/);
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
  // Shared modules of extension points come from /shared/<plugin id>.<point>/<specifier>.js (docs/spec/plugins.md#extension-points).
  assert.equal(PAGE_IMPORTS["@soksak/shared/"], "/shared/");
  assert.equal(modulePath("@scope/name", "ui/page.html"), "modules/@scope/name/ui/page.html");
  assert.throws(() => { PAGE_IMPORTS.extra = "/x.js"; }, TypeError);
});

test("a page's import map is read only when the page declares exactly one", () => {
  const map = `<script type="importmap">\n${JSON.stringify({ imports: PAGE_IMPORTS })}\n</script>`;
  assert.deepEqual(pageImports(`<title>x</title>${map}<script type="module"></script>`), { ...PAGE_IMPORTS });
  assert.throws(() => pageImports("<title>x</title>"), /found 0/);
  assert.throws(() => pageImports(map + map), /found 2/);
});

test("string settings declare a bounded non-empty default and reject other values", () => {
  const manifest = { ...card, settings: { "font.family": { label: "글꼴", type: "string", default: "D2Coding", maxLength: 16 } } };
  assert.deepEqual(validateManifest(manifest).settings["font.family"], { label: "글꼴", type: "string", default: "D2Coding", maxLength: 16 });
  const value = environment();
  value.settings.probe = { "font.family": "Menlo" };
  checkReferences(value, [manifest, side]);
  for (const invalid of ["", "a font family name that is too long", 3]) {
    value.settings.probe = { "font.family": invalid };
    assert.throws(() => checkReferences(value, [manifest, side]), /string value/);
  }
});

test("the exported sidebars validator applies the environment rules to stored sets and links", () => {
  const sidebars = () => ({
    sets: [{ id: "set-1", title: "묶음", sections: ["side.tree"], layout: "list" }],
    links: [{ place: "left", plugin: null, set: "set-1" }],
  });
  const manifests = [{ id: "side", sections: [{ id: "side.tree", name: "트리", module: "ui/tree.js" }] }];
  validateSidebars(sidebars(), "settings");
  checkSidebarReferences(sidebars(), manifests, "settings");
  for (const [change, error] of [
    [(s) => { s.sets[0].title = ""; }, /settings: set set-1 title must be 1 to 40 characters/],
    [(s) => { s.sets[0].title = "가".repeat(41); }, /title must be 1 to 40/],
    [(s) => { s.sets[0].sections.push("side.tree"); }, /without repetition/],
    [(s) => { s.sets[0].layout = "grid"; }, /layout must be list or tabs/],
    [(s) => { s.links[0].set = "set-9"; }, /known set/],
    [(s) => { s.extra = 1; }, /settings sidebars/],
  ]) {
    const value = sidebars();
    change(value);
    assert.throws(() => validateSidebars(value, "settings"), error);
  }
  const unknown = sidebars();
  unknown.sets[0].sections = ["side.gone"];
  assert.throws(() => checkSidebarReferences(unknown, manifests, "settings"), /settings: set set-1 names unknown section side.gone/);
});

test("a setting declaration requires a label and allows a description", () => {
  const withSetting = (declaration) => ({ ...card, settings: { "cursor.shape": declaration } });
  const base = { type: "enum", default: "block", values: ["block", "beam"] };
  validateManifest(withSetting({ ...base, label: "커서 모양", description: "입력 위치를 그리는 모양." }));
  assert.throws(() => validateManifest(withSetting(base)), /cursor.shape: label must be 1 to 40 characters/);
  assert.throws(() => validateManifest(withSetting({ ...base, label: "" })), /label must be 1 to 40/);
  assert.throws(() => validateManifest(withSetting({ ...base, label: "가".repeat(41) })), /label must be 1 to 40/);
  assert.throws(() => validateManifest(withSetting({ ...base, label: "모양", description: "" })), /description must be 1 to 200/);
});

test("a plugin manifest requires a description of 1 to 200 characters", () => {
  const { description, ...without } = card;
  assert.throws(() => validateManifest(without), /plugin probe: description must be 1 to 200 characters/);
  assert.throws(() => validateManifest({ ...card, description: "" }), /description must be 1 to 200/);
  assert.throws(() => validateManifest({ ...card, description: "가".repeat(201) }), /description must be 1 to 200/);
  assert.equal(validateManifest({ ...card, description: "검사용 표면." }).description, "검사용 표면.");
});

test("sidebar links allow independent window and card choices and reject repeats and reserved set ids", () => {
  const base = () => ({
    sets: [{ id: "set-1", title: "묶음", sections: [], layout: "list" }],
    links: [
      { place: "left", plugin: null, set: "set-1" },
      { place: "right", plugin: null, set: "set-1" },
      { place: "window-right", plugin: "side", set: "set-1" },
      { place: "window-left", plugin: "side", set: "set-1" },
      { place: "card-left", plugin: "side", set: "set-1" },
    ],
  });
  validateSidebars(base(), "settings");
  for (const [change, error] of [
    [(s) => { s.links.push({ place: "window-right", plugin: "side", set: "set-1" }); }, /settings: link window-right side appears twice/],
    [(s) => { s.links[0].set = null; }, /known set/],
    [(s) => { s.links[4].set = null; }, /known set/],
    [(s) => { s.links[4].plugin = null; }, /a card-left link names a plugin/],
    [(s) => { s.sets[0].id = "off"; s.links = []; }, /set id off is reserved/],
    [(s) => { s.sets[0].id = "inherit"; s.links = []; }, /set id inherit is reserved/],
  ]) {
    const value = base();
    change(value);
    assert.throws(() => validateSidebars(value, "settings"), error);
  }
});

test("references to plugins that are not loaded are kept without failing the load", () => {
  // probe 를 끄거나 제거하면 환경과 저장된 사이드바가 여전히 그것을 가리킨다(docs/spec/plugins.md).
  const value = environment();
  value.sidebars.sets[0].sections.push("probe.tree");
  value.sidebars.links.push({ place: "card-left", plugin: "probe", set: "set-side" });
  checkReferences(value, [side]);
  checkSidebarReferences(value.sidebars, [side], "settings");
});

test("references to a loaded plugin still name its declared sections and surface", () => {
  const unknown = environment();
  unknown.sidebars.sets[0].sections.push("side.missing");
  assert.throws(() => checkReferences(unknown, [card, side]), /unknown section side.missing/);
  const surfaceless = environment();
  surfaceless.sidebars.links.push({ place: "card-left", plugin: "side", set: "set-side" });
  assert.throws(() => checkSidebarReferences(surfaceless.sidebars, [card, side], "settings"), /plugin side without a surface/);
  const tab = environment();
  tab.workspace.grid.cards[1].tabs[0].plugin = "side";
  assert.throws(() => checkReferences(tab, [card, side]), /tab plugin side has no surface/);
});

const point = {
  version: "1.0.0",
  schema: { type: "object", properties: { extensions: { type: "array", items: { type: "string" } } } },
  modules: { "@scope/library": "ui/vendor/library.js" },
};
const provider = { ...card, extends: { language: point } };
const contributor = {
  id: "tidy", name: "Tidy", description: "검사용 기여.",
  contributes: { "probe.language": [{ range: "^1.0.0", module: "ui/tidy.js", extensions: ["tidy"] }] },
  dependencies: { "@scope/plugin-probe": ">=0.0.1" },
};

test("a provider declares extension points and a contributor may consist of contributions only", () => {
  assert.equal(validateManifest(provider).extends.language.version, "1.0.0");
  assert.equal(validateManifest({ ...provider, extends: { language: { version: "2.1.0", schema: { type: "object" } } } }).extends.language.version, "2.1.0");
  assert.equal(validateManifest(contributor).contributes["probe.language"][0].module, "ui/tidy.js");
  assert.equal(validateManifest({ ...side, contributes: contributor.contributes }).contributes["probe.language"].length, 1);
});

test("extension points and contributions are rejected for each invalid field", () => {
  const item = contributor.contributes["probe.language"][0];
  for (const [manifest, error] of [
    [{ ...side, extends: { language: point } }, /extends requires a surface/],
    [{ ...card, extends: [] }, /extends must be an object/],
    [{ ...card, extends: { Language: point } }, /invalid extension point Language/],
    [{ ...card, extends: { language: { ...point, version: "1.0" } } }, /extension point language version must be x.y.z/],
    [{ ...card, extends: { language: { ...point, schema: { type: "text" } } } }, /unknown schema type/],
    [{ ...card, extends: { language: { ...point, owner: "probe" } } }, /unknown field owner/],
    [{ ...card, extends: { language: { ...point, modules: { "@scope/library": "../library.js" } } } }, /extension point language module @scope\/library must be a JavaScript path inside the package/],
    [{ ...card, extends: { language: { ...point, modules: { "./library.js": "ui/library.js" } } } }, /extension point language module \.\/library\.js is not a bare specifier/],
    [{ ...contributor, contributes: [] }, /contributes must be an object/],
    [{ ...contributor, contributes: { language: [item] } }, /contributes language must be <plugin id>.<point>/],
    [{ ...contributor, contributes: { "tidy.language": [item] } }, /contributes to its own extension point tidy.language/],
    [{ ...contributor, contributes: { "probe.language": item } }, /contributes probe.language must be a non-empty array/],
    [{ ...contributor, contributes: { "probe.language": [] } }, /contributes probe.language must be a non-empty array/],
    [{ ...contributor, contributes: { "probe.language": [{ ...item, range: "latest" }] } }, /contributes probe.language item 1 range latest is invalid/],
    [{ ...contributor, contributes: { "probe.language": [{ ...item, module: "/tidy.js" }] } }, /contributes probe.language item 1 module must be a JavaScript path inside the package/],
    [{ id: "none", name: "None", description: "아무것도 없다." }, /a plugin requires a surface, sections or contributes/],
    [{ ...side, dependencies: { "@scope/sidecar-worker": "^1.2.0" } }, /dependencies require a surface, a state module or contributes/],
  ]) assert.throws(() => validateManifest(manifest), error, JSON.stringify(manifest).slice(0, 120));
});

test("a surface declares the schema of its tab parameters", () => {
  const params = { type: "object", properties: { path: { type: "string" } } };
  assert.deepEqual(validateManifest({ ...card, surface: { ...card.surface, params } }).surface.params, params);
  assert.throws(() => validateManifest({ ...card, surface: { ...card.surface, params: { type: "string" } } }),
    /surface params must be a schema of type object/);
  assert.throws(() => validateManifest({ ...card, surface: { ...card.surface, params: { type: "object", minimum: 1 } } }),
    /unknown field minimum/);
});

test("a surface that opens files declares extensions and a path parameter", () => {
  const params = { type: "object", properties: { path: { type: "string" } } };
  const opener = { ...card, surface: { ...card.surface, params, opens: { extensions: ["md", "txt"] } } };
  assert.deepEqual(validateManifest(opener).surface.opens.extensions, ["md", "txt"]);
  assert.deepEqual(validateManifest({ ...opener, surface: { ...opener.surface, opens: { extensions: ["*"] } } }).surface.opens.extensions, ["*"]);
  for (const [surface, error] of [
    [{ ...card.surface, opens: { extensions: ["md"] } }, /surface opens requires surface params with a string property path/],
    [{ ...card.surface, params: { type: "object" }, opens: { extensions: ["md"] } }, /surface opens requires surface params with a string property path/],
    [{ ...opener.surface, opens: { extensions: [] } }, /surface opens extensions must be a non-empty array/],
    [{ ...opener.surface, opens: { extensions: [".md"] } }, /surface opens extension \.md must be \* or lowercase letters and digits/],
    [{ ...opener.surface, opens: { extensions: ["MD"] } }, /surface opens extension MD must be \* or lowercase letters and digits/],
    [{ ...opener.surface, opens: { extensions: ["md", "md"] } }, /surface opens extension md is repeated/],
    [{ ...opener.surface, opens: { extensions: ["md"], mime: [] } }, /unknown field mime/],
  ]) assert.throws(() => validateManifest({ ...card, surface }), error);
});

test("a surface names its save command among its declared commands", () => {
  const exposes = { commands: [{ name: "probe.save", description: "Saves.", params: { type: "object", properties: {} }, result: { type: "null" } }] };
  assert.equal(validateManifest({ ...card, exposes, surface: { ...card.surface, save: "probe.save" } }).surface.save, "probe.save");
  assert.throws(() => validateManifest({ ...card, exposes, surface: { ...card.surface, save: "probe.write" } }),
    /surface save must name a command declared in exposes/);
});
