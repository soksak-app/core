// Tests of the module exports of scripts/check-boundaries.mjs. Importing the module runs no check and prints nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkNames, checkTestPathReads, components, corePackageFolders, corePackageNames } from "../check-boundaries.mjs";

// The names are joined from parts: the boundary audit scans this file for @soksak/ names.
const scoped = (name) => ["@soksak", name].join("/");
const core = new Set([scoped("plugin-api"), scoped("workbench")]);

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

test("components lists the core packages and the declared folders", () => {
  const found = components();
  assert.ok(found.some((item) => item.kind === "core" && item.name === scoped("plugin-api")));
  assert.ok(found.every((item) => typeof item.name === "string"));
});

test("corePackageNames reads every tracked package.json and the core-served prefix", () => {
  // Applications, the e2e package and the workbench test runtime are core packages (decision of F238-c-4).
  const names = corePackageNames();
  for (const name of [scoped("plugin-api"), scoped("browser"), scoped("e2e"), scoped("runtime"), scoped("shared")]) {
    assert.ok(names.includes(name), `${name} is a core name`);
  }
  assert.ok(!names.includes(scoped("plugin-api-x")));
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
  assert.deepEqual(checkNames(names, ["e2e/browser-cohort-upgrade.test.mjs"]), []);

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
    { dir: "packages/sok/wailsv3", kind: "core", name: scoped("sok-wails") },
    { dir: "packages/sok/tauriv2", kind: "core", name: scoped("sok-tauri") },
    { dir: "packages/log-contract", kind: "core", name: scoped("log-contract") },
    { dir: "packages/plugin-api", kind: "core", name: scoped("plugin-api") },
  ];
  const sources = {
    "packages/sok/wailsv3/tests/a_test.go": `package tests\nvar p = filepath.Join(dir, "../../../log-contract/fixtures/x.json")\n`,
    "packages/sok/tauriv2/tests/b_test.rs": `const P: &str = "/../../plugin-api/contract/x.json";\n`,
    "packages/sok/wailsv3/tests/c_test.go": `var p = filepath.Join(dir, "..", "..", "..", "log-contract", "fixtures")\n`,
    "packages/sok/wailsv3/tests/d_test.go": `var p = filepath.Join(dir, "..", "..", "..", "..", "docs", "spec", "cases", "x.json")\n`,
    "packages/sok/tauriv2/tests/e_test.rs": `const URL: &str = "/modules/@soksak/plugin-api/index.js";\n`,
    "packages/sok/tauriv2/tests/f_test.rs": `const P: &str = "/../../sok/wailsv3/tests/x.json";\n`,
    [`packages/plugin-api/test/${parts("g", ".test.mjs")}`]: `const P = new URL("../../../docs/spec/cases/x.json", import.meta.url);\n`,
    [`packages/plugin-api/test/${parts("h", ".test.mjs")}`]: `const P = new URL("../../log-contract/fixtures/x.json", import.meta.url);\n`,
  };
  const errors = checkTestPathReads(components, testFiles(Object.keys(sources)), (file) => sources[file]);
  const flagged = errors.map((error) => error.split(":")[0]).sort();
  assert.deepEqual(flagged, [
    "packages/plugin-api/test/h.test.mjs",
    "packages/sok/tauriv2/tests/b_test.rs",
    "packages/sok/tauriv2/tests/f_test.rs",
    "packages/sok/wailsv3/tests/a_test.go",
    "packages/sok/wailsv3/tests/c_test.go",
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

test("checkTestPathReads discovers the declared e2e owner from the production package list", () => {
  const owners = corePackageFolders();
  assert.ok(owners.some((owner) => owner.dir === "e2e"), "the declared e2e package owns its window checks");
  const file = "e2e/browser-cohort-upgrade.test.mjs";
  const source = `${readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")}\n` +
    `readFileSync(new URL("../packages/plugin-api/index.js", import.meta.url));\n`;
  assert.deepEqual(checkTestPathReads(owners, [file], () => source), [
    `${file}:${source.split("\n").length - 1}: test of e2e reads a path of packages/plugin-api: ../packages/plugin-api/index.js`,
  ], "the main owner discovery must reject implementation reads by an e2e test");
});
