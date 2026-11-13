// Tests of the module exports of scripts/check-boundaries.mjs. Importing the module runs no check and prints nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CORE_OWNERS, GATE_SOURCES, absentPluginIds, checkGateSources, checkNames, checkPluginNames, checkSpecReads, checkTestPathReads, classifiedFiles,
  corePackageFolders, corePackageNames, fixtureSidecarNames, namedPlugins, namedSidecars, pluginNameScope,
} from "../check-boundaries.mjs";
import { fixturePluginIds } from "../fixture-registry.mjs";

// The names are joined from parts: the boundary audit scans this file for @soksak/ names.
const scoped = (name) => ["@soksak", name].join("/");
const core = new Set([scoped("plugin-api"), scoped("workbench")]);

test("the absent plugin ids of the fixtures name no fixture plugin, and the audit accepts them as fixture ids", { timeout: 1000 }, (t) => {
  const root = fileURLToPath(new URL("../../e2e/fixtures/", import.meta.url));
  const absent = absentPluginIds(root, fixturePluginIds(root));
  assert.ok(absent.length > 0);
  assert.deepEqual(absent.filter((id) => fixturePluginIds(root).includes(id)), [], "no fixture plugin.json uses an absent plugin id");
  const fixtures = ["probeplain", "rasterprobe"];
  const dir = mkdtempSync(join(tmpdir(), "soksak-boundaries-absent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "absent-plugins.json"), JSON.stringify({ ids: ["probeplain"] }));
  assert.throws(() => absentPluginIds(dir, fixtures), /absent-plugins\.json: the fixture plugins use the absent plugin ids probeplain$/);
  writeFileSync(join(dir, "absent-plugins.json"), JSON.stringify({ ids: [] }));
  assert.throws(() => absentPluginIds(dir, fixtures), /absent-plugins\.json: ids must be a list of plugin ids$/);
  const files = { "e2e/absent.test.mjs": `await s.run("core.card.add-tab", { card, plugin: "${absent[0]}" });\n` };
  assert.deepEqual(checkPluginNames(Object.keys(files), { fixtures: [...fixtures, ...absent], readSource: (file) => files[file] }), []);
});

test("importing the boundary module runs no check", (t) => {
  // The probe is a file, so that process.argv[1] names it, as the entry guard of the imported modules expects.
  const dir = mkdtempSync(join(tmpdir(), "soksak-boundaries-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, "probe.mjs");
  const script = fileURLToPath(new URL("../check-boundaries.mjs", import.meta.url));
  writeFileSync(probe, `import ${JSON.stringify(pathToFileURL(script).href)};\n`);
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("a check names a plugin by its id, its settings keys and the namespace of the names it passes to the endpoint", { timeout: 1000 }, () => {
  assert.deepEqual(namedPlugins(`await s.run("core.card.add-tab", { plugin: "probe" });`), ["core", "probe"]);
  assert.deepEqual(namedPlugins(`const tab = tabs.find((item) => item.plugin === 'probe');`), ["probe"]);
  assert.deepEqual(namedPlugins("if (typeof fields?.plugin !== \"string\") throw new Error();"), []);
  assert.deepEqual(namedPlugins(`await press(s, "core.settings-modal.plugin", "plugin:probe");`), ["probe"]);
  assert.deepEqual(namedPlugins("await press(s, \"core.settings-modal.set\", `link:card-left:probe`);"), ["probe"]);
  assert.deepEqual(namedPlugins(`run(sok, ["plugin", "install", "probe", "--config-dir", dir]);`), ["probe"]);
  assert.deepEqual(namedPlugins("sok plugin remove probe --config-dir dir"), ["probe"]);
  assert.deepEqual(namedPlugins("run(sok, [\"plugin\", \"install\", id]); run(`sok plugin install ${id}`);"), []);
  assert.deepEqual(namedPlugins(`await s.until("probe.session", ready); const v = await child.get('other.view');`), ["probe", "other"]);
  assert.deepEqual(namedPlugins(`await s.registered("probe.focus"); const sidebar = { set: "probe.list", section: "probe.alpha" };`),
    ["probe", "probe", "probe"]);
  assert.deepEqual(namedPlugins(`await s.get("host.window"); readFileSync("probe.json");`), ["host"]);
});

test("checkPluginNames allows core, the host and the fixture plugins, and names the file, the line and any other plugin", { timeout: 1000 }, () => {
  const sources = {
    "e2e/fixture-tab.test.mjs": `await s.run("core.card.add-tab", { plugin: "layoutprobe" });\nawait s.get("host.window");\n`,
    "e2e/unknown.test.mjs": `const a = 1;\nawait s.until("unknown.session", ready);\nawait s.run("core.card.add-tab", { plugin: "unknown" });\n`,
    "e2e/listed.test.mjs": `await s.run("unknown.focus");\n`,
  };
  const errors = checkPluginNames(Object.keys(sources), {
    fixtures: ["layoutprobe"], exempt: new Set(["e2e/listed.test.mjs"]), readSource: (file) => sources[file],
  });
  assert.deepEqual(errors, [
    "e2e/unknown.test.mjs:2: names the plugin unknown, which is neither core nor a fixture plugin of e2e/fixtures",
    "e2e/unknown.test.mjs:3: names the plugin unknown, which is neither core nor a fixture plugin of e2e/fixtures",
  ]);
  assert.deepEqual(CORE_OWNERS, ["core", "host"]);
  const records = { "e2e/draw.mjs": `event.event === "sidecar.probe.frame";\nevent.event === "sidecar.real.frame";\n` };
  assert.deepEqual(checkPluginNames(["e2e/draw.mjs"], { fixtures: [], sidecars: ["probe"], readSource: (file) => records[file] }),
    ["e2e/draw.mjs:2: names the sidecar real, which is not a fixture sidecar of e2e/fixtures/sidecars"]);
  assert.deepEqual(namedSidecars(`s.until("sidecar.probe.session"); log("sidecar.json");`), ["probe"]);
  assert.deepEqual(checkPluginNames(["e2e/listed.test.mjs"], { fixtures: [], readSource: (file) => sources[file] }),
    ["e2e/listed.test.mjs:1: names the plugin unknown, which is neither core nor a fixture plugin of e2e/fixtures"],
    "a file that the classification no longer lists is checked");
});

test("the fixture sidecars are named by the package names of the sidecar folders of the fixtures", { timeout: 1000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "soksak-boundaries-sidecars-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "sidecars", "probe");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "sidecar.json"), "{}");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "@sok-check/sidecar-probe" }));
  assert.deepEqual(fixtureSidecarNames(root), ["probe"]);
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "@sok-check/probe" }));
  assert.throws(() => fixtureSidecarNames(root), /the name "@sok-check\/probe" of a fixture sidecar does not end with sidecar-<name>$/);
});

test("the plugin names are read in the checks and harness modules of e2e and scripts, not in their headless tests or the ledger", { timeout: 1000 }, () => {
  assert.deepEqual(pluginNameScope([
    "e2e/a.test.mjs", "e2e/benchmark/b.test.mjs", "e2e/helper.mjs", "e2e/fixtures/probe/ui/app.js", "scripts/run.mjs",
    "e2e/test/a.test.mjs", "scripts/test/run.test.mjs", "scripts/check-tests.mjs", "packages/workbench/a.js", "e2e/plugin.json", "docs/x.md",
  ]), ["e2e/a.test.mjs", "e2e/benchmark/b.test.mjs", "e2e/helper.mjs", "e2e/fixtures/probe/ui/app.js", "scripts/run.mjs"]);
  assert.deepEqual([...classifiedFiles({ schema: 1, files: [{ file: "e2e/a.test.mjs", owner: "core", reason: "r" }] })], ["e2e/a.test.mjs"]);
  assert.deepEqual([...classifiedFiles({ schema: 1, files: [] })], [], "an empty classification exempts no file");
  assert.throws(() => classifiedFiles({ schema: 1 }), /^Error: docs\/spec\/verification-boundaries\.json holds no list files$/);
});

test("the gate of a core release names no registry index URL, no plugin repository and no registry but the fixture registry", { timeout: 1000 }, () => {
  assert.deepEqual(GATE_SOURCES, ["Makefile", "scripts/acceptance-run.mjs", "scripts/candidate-acceptance.mjs", "scripts/candidate-context.mjs", "scripts/test-app.mjs"]);
  const sources = {
    "Makefile": "FIXTURE_REGISTRY = target/fixture-registry\nINDEX = https://example.test/registry/index.json\n",
    "scripts/test-app.mjs": "const registry = join(root, 'target', 'fixture-registry');\nconst plugins = '../plugins/probe';\nconst old = 'target/registry/index.json';\n",
    "scripts/acceptance-run.mjs": "const sidecar = \"../sidecars/probe\";\nconst publicIndex = `target/registry-public/index.json`;\n",
  };
  assert.deepEqual(checkGateSources(Object.keys(sources), (file) => sources[file]), [
    "Makefile:2: the gate of a core release names a registry index URL",
    "scripts/test-app.mjs:2: the gate of a core release names a plugin repository path",
    "scripts/test-app.mjs:3: the gate of a core release names a registry other than the fixture registry",
    "scripts/acceptance-run.mjs:1: the gate of a core release names a plugin repository path",
    "scripts/acceptance-run.mjs:2: the gate of a core release names a registry other than the fixture registry",
  ]);
});

test("corePackageNames reads every tracked package.json and the core-served prefix", () => {
  // Applications, the e2e package and the workbench test runtime are core packages (decision of F238-c-4).
  const names = corePackageNames();
  for (const name of [scoped("plugin-api"), scoped("browser"), scoped("e2e"), scoped("runtime"), scoped("shared")]) {
    assert.ok(names.includes(name), `${name} is a core name`);
  }
  assert.ok(!names.includes(scoped("plugin-api-x")));
});

test("corePackageNames includes a kit release that a core manifest declares, and no other declared name", () => {
  const names = corePackageNames();
  assert.ok(names.includes(scoped("kit")), "the kit that package.json declares is a core name");
  assert.ok(!names.includes(scoped("kit-x")));
});

test("checkNames allows the exact core names and refuses the others", () => {
  const files = ["packages/x/a.js", "packages/x/b.ts"];
  const source = {
    "packages/x/a.js": `import "${scoped("plugin-api")}";\nimport "${scoped("plugin-api")}/view";\n`,
    "packages/x/b.ts": `import "${scoped("plugin-api-x")}";\n`,
  };
  const errors = checkNames(core, files, (file) => source[file]);
  assert.deepEqual(errors, [
    `packages/x/b.ts:1: core source names ${scoped("plugin-api")}-x, which is not a core package`,
  ]);
});

test("boundary names distinguish declared window checks from core tests without permitting implementation reads", { timeout: 1000 }, () => {
  const names = new Set(corePackageNames());
  const declared = [
    'import { APPS, open } from "@soksak/window-check/app.mjs";',
    "for (const app of Object.values(APPS)) test(app.name, async (t) => { await open(t, app); });",
    `const dependency = "${scoped("sidecar-probe")}";`,
  ].join("\n");
  assert.deepEqual(checkNames(names, ["e2e/window-check.test.mjs"], () => declared), [],
    "a declared window check names the packages of its environment");

  const source = [
    'import { open as launch } from "@soksak/window-check/app.mjs";',
    "await launch(context, application);",
    `const dependency = "${scoped("sidecar-probe")}";`,
  ].join("\n");
  assert.deepEqual(checkNames(names, ["e2e/window-like.test.mjs"], () => source), [],
    "an aliased window-check opener must retain its declared role");
  const packageFile = "packages/workbench/test/window-check.test.mjs";
  assert.deepEqual(checkNames(names, [packageFile], () => source), [
    `${packageFile}:3: core source names ${scoped("sidecar-probe")}, which is not a core package`,
  ]);

  const fake = [
    '// import { open } from "@soksak/window-check/app.mjs";',
    'const note = "open(context, application)";',
    `const dependency = "${scoped("sidecar-probe")}";`,
  ].join("\n");
  assert.equal(checkNames(names, ["e2e/window-like.test.mjs"], () => fake).length, 1,
    "comments and strings must not classify a package test as a window check");
  const shadowed = [
    'import { open as launch } from "@soksak/window-check/app.mjs";',
    "function helper(launch) { launch(context, application); }",
    `const dependency = "${scoped("sidecar-probe")}";`,
  ].join("\n");
  assert.equal(checkNames(names, ["e2e/window-like.test.mjs"], () => shadowed).length, 1,
    "a shadowed local function must not count as calling the imported opener");

  const components = [
    { dir: "e2e", kind: "core", name: scoped("e2e") },
    { dir: "packages/workbench", kind: "core", name: scoped("workbench") },
    { dir: "packages/plugin-api", kind: "core", name: scoped("plugin-api") },
  ];
  const windowFile = "e2e/window-like.test.mjs";
  const readFile = {
    [packageFile]: `${source}\nreadFileSync(new URL("../../plugin-api/index.js", import.meta.url));`,
    [windowFile]: `${source}\nreadFileSync(new URL("../packages/plugin-api/index.js", import.meta.url));`,
  };
  assert.deepEqual(checkTestPathReads(components, [packageFile, windowFile], (file) => readFile[file]), [
    `${packageFile}:4: test of ${scoped("workbench")} reads a path of ${scoped("plugin-api")}: ../../plugin-api/index.js`,
    `${windowFile}:4: test of ${scoped("e2e")} reads a path of ${scoped("plugin-api")}: ../packages/plugin-api/index.js`,
  ], "a window-check import must not exempt implementation path reads");
});

test("checkNames reports a file it cannot read", () => {
  const errors = checkNames(core, ["packages/x/missing.js"], () => {
    throw new Error("gone");
  });
  assert.deepEqual(errors, ["packages/x/missing.js: cannot be read: gone"]);
});

// The rule of decision D3, rule 1: a core source names only exact core package names, declared or not.
const cases = [
  ["packages/x/x.js", `import "${scoped("plugin-foo")}";\n`, false],
  ["packages/x/x.ts", `import "${scoped("plugin-foo")}";\n`, false],
  ["packages/x/x.js", `import "${scoped("sidecar-vt-alacritty")}";\n`, false],
  ["packages/x/x.js", `import "${scoped("sidecar-example")}";\n`, false],
  ["packages/x/x.js", `import "${scoped("plugin-api-x")}";\n`, false],
  ["packages/x/x.js", `import "${scoped("plugin-browser")}";\n`, false],
  ["apps/x/x.js", `import "${scoped("hwp")}";\n`, false],
  ["packages/x/x.js", 'import "@scope/sidecar-vt";\n', true],
  ["packages/x/x.js", `import "${scoped("plugin-api")}";\n`, true],
];
for (const [file, text, allowed] of cases) {
  test(`core name rule: ${file} ${allowed ? "allows" : "refuses"} ${text.trim()}`, () => {
    const errors = checkNames(core, [file], () => text);
    assert.equal(errors.length === 0, allowed, errors.join("\n"));
  });
}

// The test paths: a test file under a component's test folder, or a file named as a test of Go, Rust or Node.
const TEST_FILE = /(^|\/)tests?\/|_test\.(go|rs)$|\.test\.mjs$/;
const testFiles = (files) => files.filter((file) => TEST_FILE.test(file));

test("checkTestPathReads refuses a test that reads a path of another core package", () => {
  // A test reads its own package and the repository's docs; a read of another package's folder is refused.
  const parts = (...items) => items.join("");
  const components = [
    { dir: "packages/sok/go", kind: "core", name: scoped("sok-wails") },
    { dir: "packages/sok/rust", kind: "core", name: scoped("sok-tauri") },
    { dir: "packages/log-contract", kind: "core", name: scoped("log-contract") },
    { dir: "packages/plugin-api", kind: "core", name: scoped("plugin-api") },
  ];
  const sources = {
    "packages/sok/go/tests/a_test.go": `package tests\nvar p = filepath.Join(dir, "../../../log-contract/fixtures/x.json")\n`,
    "packages/sok/rust/tests/b_test.rs": `const P: &str = "/../../plugin-api/contract/x.json";\n`,
    "packages/sok/go/tests/c_test.go": `var p = filepath.Join(dir, "..", "..", "..", "log-contract", "fixtures")\n`,
    "packages/sok/go/tests/d_test.go": `var p = filepath.Join(dir, "..", "..", "..", "..", "docs", "spec", "cases", "x.json")\n`,
    "packages/sok/rust/tests/e_test.rs": `const URL: &str = "/modules/@soksak/plugin-api/index.js";\n`,
    "packages/sok/rust/tests/f_test.rs": `const P: &str = "/../../sok/go/tests/x.json";\n`,
    [`packages/plugin-api/test/${parts("g", ".test.mjs")}`]: `const P = new URL("../../../docs/spec/cases/x.json", import.meta.url);\n`,
    [`packages/plugin-api/test/${parts("h", ".test.mjs")}`]: `const P = new URL("../../log-contract/fixtures/x.json", import.meta.url);\n`,
  };
  const errors = checkTestPathReads(components, testFiles(Object.keys(sources)), (file) => sources[file]);
  const flagged = errors.map((error) => error.split(":")[0]).sort();
  assert.deepEqual(flagged, [
    "packages/plugin-api/test/h.test.mjs",
    "packages/sok/go/tests/a_test.go",
    "packages/sok/go/tests/c_test.go",
    "packages/sok/rust/tests/b_test.rs",
    "packages/sok/rust/tests/f_test.rs",
  ]);
});

test("checkTestPathReads does not refuse a path that a test names as the key of a fake source", () => {
  // The key of a map that a test passes to a checker names no file; only a line that reads a file is a read.
  const components = [
    { dir: "packages/plugin-api", kind: "core", name: scoped("plugin-api") },
    { dir: "packages/workbench", kind: "core", name: scoped("workbench") },
  ];
  const sources = {
    "packages/plugin-api/test/fake.test.mjs": "const source = new Map([['packages/workbench/surface-modules.js', 'text']]);\n",
    "packages/plugin-api/test/read.test.mjs": "const text = readFileSync(new URL('../../workbench/surface-modules.js', import.meta.url));\n",
  };
  const errors = checkTestPathReads(components, testFiles(Object.keys(sources)), (file) => sources[file]);
  assert.deepEqual(errors.map((error) => error.split(":")[0]), ["packages/plugin-api/test/read.test.mjs"]);
});

test("checkSpecReads refuses a read of docs/spec that specFiles of the package does not declare", () => {
  // A change of a specification file selects the tests of the packages that declare it (scripts/node-tests.mjs --changed).
  const manifests = {
    "packages/reader": { specFiles: ["docs/spec/cases/log-contract/", "docs/spec/replay.md", "docs/spec/gone.md", "docs/spec/unread.md"] },
    "packages/silent": {},
    "packages/wrong": { specFiles: ["docs/features.md"] },
  };
  const sources = {
    "packages/reader/test/a.test.mjs": [
      'const catalog = readFileSync(new URL("../../../docs/spec/events.json", import.meta.url));',
      "const read = (name) => readFileSync(new URL(`../../../docs/spec/cases/log-contract/replay/${name}`, import.meta.url));",
      'const replay = read("../../../docs/spec/replay.md");',
      "const CATALOG = 'docs/spec/events.json';",
    ].join("\n"),
    "packages/reader/test/b.go": 'var p = "../../../docs/spec/hosts.md"\n',
    "packages/silent/index.js": 'const spec = new URL("../../docs/spec/hosts.md", import.meta.url);\n',
  };
  const existing = new Set(["docs/spec/cases/log-contract/", "docs/spec/replay.md", "docs/spec/unread.md"]);
  const errors = checkSpecReads(Object.keys(manifests), Object.keys(sources), {
    readManifest: (folder) => manifests[folder],
    readSource: (file) => sources[file],
    exists: (path) => existing.has(path),
  });
  assert.deepEqual(errors, [
    "packages/reader/test/a.test.mjs:1: packages/reader reads docs/spec/events.json, which specFiles of packages/reader/package.json does not declare",
    "packages/reader/package.json: specFiles names docs/spec/gone.md, which does not exist",
    "packages/reader/package.json: specFiles names docs/spec/unread.md, which no source of packages/reader reads",
    "packages/silent/index.js:1: packages/silent reads docs/spec/hosts.md, which specFiles of packages/silent/package.json does not declare",
    'packages/wrong/package.json: specFiles must be a list of paths under docs/spec/, found ["docs/features.md"]',
  ]);
});

test("checkTestPathReads discovers the declared e2e owner from the production package list", () => {
  const owners = corePackageFolders();
  assert.ok(owners.some((owner) => owner.dir === "e2e"), "the declared e2e package owns its window checks");
  const file = "e2e/memory-saver.test.mjs";
  const source = `${readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")}\n` +
    `readFileSync(new URL("../packages/plugin-api/index.js", import.meta.url));\n`;
  assert.deepEqual(checkTestPathReads(owners, [file], () => source), [
    `${file}:${source.split("\n").length - 1}: test of e2e reads a path of packages/plugin-api: ../packages/plugin-api/index.js`,
  ], "the main owner discovery must reject implementation reads by an e2e test");
});

test("e2e fixture payload manifests do not create independent core test owners", { timeout: 1000 }, () => {
  const owners = corePackageFolders();
  const e2eTest = "e2e/test/fixture-owner.test.mjs";
  const fixtureManifest = "../fixtures/memory-saver/unload-probe/package.json";
  const fixtureSource = "../fixtures/memory-saver/unload-probe/ui/app.js";
  const source = [
    `readFileSync(new URL(${JSON.stringify(fixtureManifest)}, import.meta.url));`,
    `readFileSync(new URL(${JSON.stringify(fixtureSource)}, import.meta.url));`,
  ].join("\n");

  assert.ok(!owners.some((owner) => owner.dir.startsWith("e2e/fixtures/")));
  assert.deepEqual(checkTestPathReads(owners, [e2eTest], () => source), []);

  const coreTest = "packages/workbench/test/fixture-owner.test.mjs";
  const coreSource = 'readFileSync(new URL("../../../e2e/fixtures/memory-saver/unload-probe/ui/app.js", import.meta.url));';
  assert.deepEqual(checkTestPathReads(owners, [coreTest], () => coreSource), [
    `${coreTest}:1: test of packages/workbench reads a path of e2e: ../../../e2e/fixtures/memory-saver/unload-probe/ui/app.js`,
  ]);
});

test("fixture payload manifests of a package's tests do not create independent core test owners", { timeout: 1000 }, () => {
  const owners = corePackageFolders();
  assert.ok(!owners.some((owner) => /(^|\/)fixtures\//.test(owner.dir)));
  const support = "packages/host/go/tests/support/plugins.go";
  const own = 'return filepath.Join(filepath.Dir(here), "..", "fixtures", "plugin-probe")\n';
  assert.deepEqual(checkTestPathReads(owners, [support], () => own), []);
  const other = 'return filepath.Join(filepath.Dir(here), "..", "..", "..", "rust", "tests", "fixtures", "plugin-probe")\n';
  assert.deepEqual(checkTestPathReads(owners, [support], () => other), [
    `${support}:1: test of packages/host/go reads a path of packages/host/rust: ${other.trim()}`,
  ]);
});
