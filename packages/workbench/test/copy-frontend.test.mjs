// Checks that staging puts the diagnostics module only in the diagnostic build, and that an application without a host uses the installed plugins as the host.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { PAGE_IMPORTS, VIEW_IMPORTS, VIEW_IMPORTS_FILE, importSpecifiers, pageImports, viewImports } from "@soksak/plugin-api";
import { STAGED, missingPageReferences, pageReferences } from "../staged.js";

const STAGE = fileURLToPath(new URL("../copy-frontend.mjs", import.meta.url));
const OBSERVE = fileURLToPath(new URL("../observe.js", import.meta.url));
const RELEASE_DIAGNOSTICS = fileURLToPath(new URL("../release-diagnostics.js", import.meta.url));

/** A fake application without plugins. */
function fixtureApp(t) {
  const app = mkdtempSync(join(tmpdir(), "soksak-stage-"));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(join(app, "runtime"));
  writeFileSync(join(app, "runtime/index.js"), "export const host = null;\n");
  writeFileSync(join(app, "runtime/start.js"), "export default { workspace: { common: {}, projects: [] }, controls: null };\n");
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "fixture-app", private: true }));
  writeFileSync(join(app, "environment.json"), JSON.stringify({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "x", title: "x" }] }] } },
    sidebars: { sets: [], links: [] },
  }));
  return app;
}

const stage = (app, ...flags) => execFileSync(process.execPath, [STAGE, "out", ...flags], { cwd: app, encoding: "utf8" });

test("a staged frontend without --diagnostics has an empty diagnostics module and no diagnostic code", (t) => {
  const app = fixtureApp(t);
  stage(app);
  const module = readFileSync(join(app, "out/diagnostics.js"), "utf8");
  assert.equal(module, readFileSync(RELEASE_DIAGNOSTICS, "utf8"));
  assert.doesNotMatch(module, /diagnostics\.\w+|registry|import/);
  assert.deepEqual(pageImports(readFileSync(join(app, "out/index.html"), "utf8")), PAGE_IMPORTS,
    "a release workbench page keeps only the release imports");
  assert.equal(existsSync(join(app, "out/observe.js")), false);
  assert.equal(existsSync(join(app, "out/transcript.js")), false);
  assert.equal(existsSync(join(app, "out/modules/@soksak/plugin-api/diagnostic-view-frames.js")), false,
    "the diagnostic view observer is absent from a release bundle");
  assert.doesNotMatch(readFileSync(join(app, "out/host.js"), "utf8"), /diagnostics\.\w+|transcript/i);
});

test("a staged frontend with --diagnostics has the page diagnostic methods", (t) => {
  const app = fixtureApp(t);
  assert.match(stage(app, "--diagnostics"), /with diagnostics/);
  assert.equal(readFileSync(join(app, "out/diagnostics.js"), "utf8"), readFileSync(OBSERVE, "utf8"));
  assert.equal(existsSync(join(app, "out/transcript.js")), true);
  assert.equal(existsSync(join(app, "out/modules/@soksak/plugin-api/diagnostic-view-frames.js")), true,
    "the diagnostic view observer is staged for view checks");
  assert.ok(JSON.parse(readFileSync(join(app, "out/core-root.json"), "utf8"))
    .includes("/modules/@soksak/plugin-api/diagnostic-view-frames.js"), "the host serves the diagnostic view observer to view documents");
  const imports = pageImports(readFileSync(join(app, "out/index.html"), "utf8"));
  assert.equal(imports["@soksak/plugin-api/diagnostic-view-frames"],
    "/modules/@soksak/plugin-api/diagnostic-view-frames.js",
    "the workbench page resolves diagnostic modules imported from installed plugins");
  const releaseImports = Object.fromEntries(Object.entries(imports)
    .filter(([name]) => name !== "@soksak/plugin-api/diagnostic-view-frames"));
  assert.deepEqual(releaseImports,
    { ...PAGE_IMPORTS }, "diagnostic staging adds only the helper required by installed diagnostic modules");
});

/** A fake application of a host that stages no main page: it has no runtime directory and its environment names none. */
function viewRootApp(t) {
  const app = fixtureApp(t);
  rmSync(join(app, "runtime"), { recursive: true });
  const environment = JSON.parse(readFileSync(join(app, "environment.json"), "utf8"));
  delete environment.runtime;
  writeFileSync(join(app, "environment.json"), JSON.stringify(environment));
  return app;
}

test("an application without a main page stages the view root and no page file", (t) => {
  const app = viewRootApp(t);
  assert.match(stage(app, "--no-main-page"), /view root/);
  assert.deepEqual(readdirSync(join(app, "out")).sort(),
    ["core-root.json", "environment.json", "modules", "view-imports.json"]);
  for (const target of JSON.parse(readFileSync(join(app, "out/core-root.json"), "utf8"))) {
    assert.equal(existsSync(join(app, "out", target)), true, `${target} is a staged core target`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(app, "out/view-imports.json"), "utf8")), { imports: VIEW_IMPORTS });
  assert.equal(existsSync(join(app, "out/modules/@soksak/plugin-api/diagnostic-view-frames.js")), false,
    "the diagnostic view observer is absent from a release view root");
});

test("an application without a main page keeps the diagnostic view observer with --diagnostics", (t) => {
  const app = viewRootApp(t);
  stage(app, "--no-main-page", "--diagnostics");
  assert.equal(existsSync(join(app, "out/diagnostics.js")), false, "the page diagnostic module has no page to run in");
  assert.ok(JSON.parse(readFileSync(join(app, "out/core-root.json"), "utf8"))
    .includes("/modules/@soksak/plugin-api/diagnostic-view-frames.js"));
  assert.ok("@soksak/plugin-api/diagnostic-view-frames" in JSON.parse(readFileSync(join(app, "out/view-imports.json"), "utf8")).imports);
});

test("staging a main page requires the runtime of the application", (t) => {
  const app = viewRootApp(t);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out"], { cwd: app, stdio: "pipe" }),
    (error) => /a main page requires runtime in environment.json/.test(error.stderr.toString()));
});

test("an application that names a runtime stages a main page", (t) => {
  const app = fixtureApp(t);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--no-main-page"], { cwd: app, stdio: "pipe" }),
    (error) => /--no-main-page refuses the runtime of environment.json/.test(error.stderr.toString()));
});

test("unknown staging arguments are rejected", (t) => {
  const app = fixtureApp(t);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--release"], { cwd: app, stdio: "pipe" }), /usage/);
});

test("staging keeps the registry that the application declares and takes no registry override", (t) => {
  const app = fixtureApp(t);
  const sourceEnvironment = JSON.parse(readFileSync(join(app, "environment.json"), "utf8"));
  sourceEnvironment.registry = "https://registry.example/index.json";
  writeFileSync(join(app, "environment.json"), JSON.stringify(sourceEnvironment));

  stage(app, "--diagnostics");

  assert.equal(JSON.parse(readFileSync(join(app, "out/environment.json"), "utf8")).registry, "https://registry.example/index.json");
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--registry-index", join(app, "index.json")], { cwd: app, stdio: "pipe" }),
    (error) => /Unknown option '--registry-index'/.test(error.stderr.toString()));
});

/** A configuration directory with two enabled plugins and one disabled plugin installed. probe holds the diagnostics declaration. */
function installedConfiguration(t) {
  const configuration = mkdtempSync(join(tmpdir(), "soksak-installed-"));
  t.after(() => rmSync(configuration, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(configuration, path, ".."), { recursive: true });
    writeFileSync(join(configuration, path), text);
  };
  const folder = (id, version) => `plugins/${id}/${version}`;
  write("plugins/installed.json", JSON.stringify({ format: 3, plugins: {
    probe: { version: "0.1.0", path: folder("probe", "0.1.0"), enabled: true, sidecars: {} },
    alpha: { version: "1.0.0", path: folder("alpha", "1.0.0"), enabled: true, sidecars: {} },
    off: { version: "1.0.0", path: folder("off", "1.0.0"), enabled: false, sidecars: {} },
  }, sidecars: {} }));
  write("plugins/probe/0.1.0/package.json", JSON.stringify({ name: "@fixture/probe" }));
  write("plugins/alpha/1.0.0/package.json", JSON.stringify({ name: "plugin-alpha" }));
  write("plugins/off/1.0.0/package.json", JSON.stringify({ name: "plugin-off" }));
  write("plugins/probe/0.1.0/plugin.json", JSON.stringify(MANIFESTS.probe));
  write("plugins/probe/0.1.0/ui/probe.js", "export function mount() {}\n");
  write("plugins/probe/0.1.0/ui/vendor/library.js", "export const library = 1;\n");
  write("plugins/probe/0.1.0/diagnostics.json", JSON.stringify(DIAGNOSTICS));
  write("plugins/alpha/1.0.0/plugin.json", JSON.stringify(MANIFESTS.alpha));
  write("plugins/off/1.0.0/plugin.json", "{}");
  return configuration;
}

const MANIFESTS = {
  probe: { id: "probe", name: "Probe", description: "검사용 표면.", mark: "P", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
    extends: { language: { version: "1.0.0", schema: { type: "object" }, modules: { "@scope/library": "ui/vendor/library.js" } } } },
  alpha: { id: "alpha", name: "Alpha", description: "검사용 섹션.", sections: [{ id: "alpha.list", name: "List", composition: { kind: "view", page: "ui/list.html", regions: [{ name: "list", kind: "document", input: "native" }], overlays: [] }, height: "fill" }], exposes: { status: [{ name: "alpha.list", description: "검사용 상태.", schema: { type: "object" } }] } },
};

const DIAGNOSTICS = {
  module: "ui/probe-diagnostics.js",
  exposes: { commands: [{
    name: "probe.inject", description: "Injects.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] },
};

test("an application without a host stages the enabled installed plugins as a host would serve them", (t) => {
  const app = fixtureApp(t);
  const configuration = installedConfiguration(t);
  stage(app, "--installed", configuration);
  assert.deepEqual(JSON.parse(readFileSync(join(app, "out/installed-plugins.json"), "utf8")), { plugins: [
    { id: "alpha", package: "plugin-alpha", version: "1.0.0", manifest: MANIFESTS.alpha },
    { id: "probe", package: "@fixture/probe", version: "0.1.0", manifest: MANIFESTS.probe },
  ] });
  assert.equal(readFileSync(join(app, "out/modules/@fixture/probe/ui/probe.js"), "utf8"), "export function mount() {}\n");
  assert.equal(existsSync(join(app, "out/modules/plugin-off")), false);
  // The shared modules of extension points are placed where a host serves /shared/<plugin id>.<point>/<specifier>.js.
  assert.equal(readFileSync(join(app, "out/shared/probe.language/@scope/library.js"), "utf8"), "export const library = 1;\n");
  stage(app, "--installed", configuration, "--diagnostics");
  assert.deepEqual(JSON.parse(readFileSync(join(app, "out/installed-plugins.json"), "utf8")).plugins[1].diagnostics, DIAGNOSTICS);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--installed", join(configuration, "missing")], { cwd: app, stdio: "pipe" }),
    /installed\.json does not exist; install plugins with sok first/);
});

test("an application without a host stages the installed plugins without sidecar facts", (t) => {
  const app = fixtureApp(t);
  const configuration = mkdtempSync(join(tmpdir(), "soksak-installed-plugins-"));
  t.after(() => rmSync(configuration, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(configuration, path, ".."), { recursive: true });
    writeFileSync(join(configuration, path), text);
  };
  write("plugins/installed.json", JSON.stringify({ format: 3, plugins: {
    probe: { version: "0.1.0", path: "plugins/probe/0.1.0", enabled: true, sidecars: { "@fixture/sidecar-probe": "^0.1.0" } },
  }, sidecars: { "@fixture/sidecar-probe": { version: "0.1.0", path: "sidecars/fixture-sidecar-probe/0.1.0/darwin-arm64" } } }));
  write("plugins/probe/0.1.0/package.json", JSON.stringify({ name: "@fixture/probe" }));
  write("plugins/probe/0.1.0/plugin.json", JSON.stringify({ id: "probe", name: "Probe", description: "검사용.", mark: "p", icon: "<path/>", surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
    dependencies: { "@fixture/sidecar-probe": "^0.1.0" } }));
  write("sidecars/fixture-sidecar-probe/0.1.0/darwin-arm64/sidecar.json", JSON.stringify({ executable: "build/worker", protocol: 1,
    message: { form: "json-object", operationField: "operation" } }));
  stage(app, "--installed", configuration);
  const [plugin] = JSON.parse(readFileSync(join(app, "out/installed-plugins.json"), "utf8")).plugins;
  assert.equal(Object.hasOwn(plugin, "sidecars"), false, "the staged document carries sidecar facts");
});

test("staging reads the installed state format that sok writes and refuses every other format by name", (t) => {
  const app = fixtureApp(t);
  const configuration = installedConfiguration(t);
  const file = join(configuration, "plugins/installed.json");
  const installed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(installed.format, 3);
  stage(app, "--installed", configuration);
  assert.equal(JSON.parse(readFileSync(join(app, "out/installed-plugins.json"), "utf8")).plugins.length, 2);
  for (const format of [1, 2, 4]) {
    writeFileSync(file, JSON.stringify({ ...installed, format }));
    assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--installed", configuration], { cwd: app, stdio: "pipe" }),
      new RegExp(`installed\\.json: format ${format} is not 3, the format that sok writes`));
  }
});

test("staging refuses an installed.json entry that holds package", (t) => {
  const app = fixtureApp(t);
  const configuration = installedConfiguration(t);
  const file = join(configuration, "plugins/installed.json");
  const installed = JSON.parse(readFileSync(file, "utf8"));
  installed.plugins.alpha.package = "plugin-alpha";
  writeFileSync(file, JSON.stringify(installed));
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--installed", configuration], { cwd: app, stdio: "pipe" }),
    (error) => error.stderr.toString().includes(`${file}: plugins/installed.json alpha: unknown field package`));
});

test("a native application stages no plugin and no installed plugin document", (t) => {
  const app = fixtureApp(t);
  stage(app, "--diagnostics");
  assert.equal(existsSync(join(app, "out/installed-plugins.json")), false);
  assert.equal(existsSync(join(app, "out/diagnostic-plugins.json")), false);
  assert.throws(() => execFileSync(process.execPath, [STAGE, "out", "--executables", "bin"], { cwd: app, stdio: "pipe" }), /usage/);
});

test("staging writes core-root.json with the core targets of the view import map", (t) => {
  const app = fixtureApp(t);
  stage(app);
  assert.equal(existsSync(join(app, "out/surface-sync-request.js")), true,
    "the host request normalizer must be present in the staged page assets");
  assert.equal(existsSync(join(app, "out/core-root.json")), true);
  const targets = JSON.parse(readFileSync(join(app, "out/core-root.json"), "utf8"));
  assert.deepEqual(targets, [...targets].sort());
  assert.ok(targets.includes("/modules/@soksak/plugin-api/view.js"));
  assert.ok(targets.includes("/modules/soksak/dist/index.js"));
  assert.ok(targets.includes("/modules/soksak/dist/soksak.js"));
  for (const path of targets) assert.equal(existsSync(join(app, "out", path)), true, path);
});

test("staging writes the view import map as the JSON text of VIEW_IMPORTS, which each host passes to the view handler", (t) => {
  const app = fixtureApp(t);
  stage(app);
  assert.equal(readFileSync(join(app, "out", VIEW_IMPORTS_FILE), "utf8"), JSON.stringify({ imports: VIEW_IMPORTS }));
  stage(app, "--diagnostics");
  assert.equal(readFileSync(join(app, "out", VIEW_IMPORTS_FILE), "utf8"),
    JSON.stringify({ imports: viewImports({ diagnostics: true }) }));
});

/** The scripts and styles that a page names, read by a browser parser, with the specifiers of its inline scripts. */
function parsedReferences(html) {
  const { document } = new JSDOM(html).window;
  return [
    ...[...document.querySelectorAll("script:not([type=importmap])")].flatMap((script) => (script.src ? [script.getAttribute("src")] : importSpecifiers(script.textContent))),
    ...[...document.querySelectorAll("link[rel=stylesheet]")].map((link) => link.getAttribute("href")),
  ];
}

test("staging reads the references of a page as a browser parser does", (t) => {
  const app = fixtureApp(t);
  stage(app);
  for (const page of STAGED.pages) {
    const html = readFileSync(join(app, "out", page), "utf8");
    assert.deepEqual(pageReferences(html), parsedReferences(html), page);
  }
});

test("staging holds every file that a staged page reaches, in a release and in a diagnostic build", (t) => {
  for (const flags of [[], ["--diagnostics"]]) {
    const app = fixtureApp(t);
    stage(app, ...flags);
    for (const page of STAGED.pages) {
      assert.deepEqual(missingPageReferences(join(app, "out"), page), [], `${page} ${flags.join(" ")}`);
    }
  }
});

test("staging leaves the imports of the application runtime to its host", (t) => {
  const app = fixtureApp(t);
  writeFileSync(join(app, "runtime/index.js"), "import \"/wails/runtime.js\";\nexport const host = null;\n");
  writeFileSync(join(app, "runtime/start.js"), "import start from \"soksak://core/start.json\" with { type: \"json\" };\nexport default start;\n");
  assert.match(stage(app), /staged the workbench/);
});

/** A copy of the workbench package whose files leave out one file that a page reaches. */
function workbenchWithout(t, file) {
  const copy = mkdtempSync(join(tmpdir(), "soksak-workbench-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  cpSync(source, copy, { recursive: true, filter: (path) => !/\/(node_modules|test)(\/|$)/.test(path.slice(source.length - 1)) });
  symlinkSync(join(source, "node_modules"), join(copy, "node_modules"));
  const manifest = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
  writeFileSync(join(copy, "package.json"), JSON.stringify({ ...manifest, files: manifest.files.filter((name) => name !== file) }));
  return copy;
}

test("staging fails on a page that reaches a file that is not staged, and names the file", (t) => {
  const app = fixtureApp(t);
  const workbench = workbenchWithout(t, "head-fit.js");
  const run = spawnSync(process.execPath, [join(workbench, "copy-frontend.mjs"), "out"], { cwd: app, encoding: "utf8" });
  assert.notEqual(run.status, 0, "staging succeeded without a file that a page reaches");
  assert.match(run.stderr, /plane\.js imports \.\/head-fit\.js, which is not staged/);
});
