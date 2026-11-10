import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { auditWorkbenchCases, auditCompletedFeatureLinks, auditFixedTemporaryPaths, auditJoinedFailures, auditExecutableLanguageCoverage, auditFailureMatrix, auditFeatureLinks, auditGoFailurePropagation, auditInventory, auditJsFailurePropagation, auditNativeFailurePropagation, auditOwnership, inventorySummary, auditRustFailurePropagation, discoverInventory, packageIndex, repositoryFiles, auditRequirementCoverage, readRequirementScope, requirementSummary } from "../check-tests.mjs";

const files = repositoryFiles();

function requirementFixture() {
  return {
    features: [{ id: "F1", implementation: [{ file: "unit.js", symbol: "run" }],
      expected: "An accepted operation completes and a refused operation preserves state.", levels: ["unit"],
      requirement: { key: "operation", inapplicable: {}, platforms: {
        darwin: { status: "required" }, linux: { status: "required" }, win32: { status: "required" },
      } },
      tests: [{ file: "unit.test.mjs", id: "accepted and refused operations", covers: ["normal", "failure", "race", "recovery"] }],
    }],
    scope: ["operation"], files: ["unit.js", "unit.test.mjs"],
    read: (file) => file === "unit.js" ? "export function run() {}" : 'test("accepted and refused operations", () => {});',
  };
}

function requirementErrors(fixture) {
  return auditFeatureLinks(fixture.features, fixture.files, fixture.read, { requirementScope: fixture.scope });
}

test("requirement audit rejects a removed requirement and every omitted scenario dimension", () => {
  const absent = requirementFixture();
  delete absent.features[0].requirement;
  assert.match(requirementErrors(absent).join("\n"), /operation: required behavior has no scenario mapping/);
  for (const dimension of ["normal", "failure", "race", "recovery"]) {
    const fixture = requirementFixture();
    fixture.features[0].tests[0].covers = fixture.features[0].tests[0].covers.filter((value) => value !== dimension);
    assert.match(requirementErrors(fixture).join("\n"), new RegExp(`operation: missing ${dimension} scenario`));
  }
});

test("requirement audit rejects duplicate requirements and invalid scenario references", () => {
  const duplicate = requirementFixture();
  duplicate.features.push({ ...structuredClone(duplicate.features[0]), id: "F2" });
  assert.match(requirementErrors(duplicate).join("\n"), /operation: requirement is duplicated/);
  const invalid = requirementFixture();
  invalid.features[0].tests[0].id = "unregistered behavior";
  assert.match(requirementErrors(invalid).join("\n"), /behavior test id is not present/);
  invalid.features[0].tests[0].file = "missing.test.mjs";
  assert.match(requirementErrors(invalid).join("\n"), /behavior test file is not in the workspace/);
  const repeated = requirementFixture();
  repeated.features[0].tests.push(structuredClone(repeated.features[0].tests[0]));
  assert.match(requirementErrors(repeated).join("\n"), /duplicate scenario test reference/);
  for (const covers of [["normal", "normal"], ["success"], []]) {
    const fixture = requirementFixture();
    fixture.features[0].tests[0].covers = covers;
    assert.match(requirementErrors(fixture).join("\n"), /invalid or duplicate scenario dimension/);
  }
});

test("requirement audit requires explicit platform obligations and concrete unavailable reasons", () => {
  for (const value of [undefined, { status: "pass" }, { status: "unavailable" },
    { status: "unavailable", reason: " ", resumeWhen: "Implement the capture backend." },
    { status: "unavailable", reason: "No capture backend exists.", resumeWhen: " " }]) {
    const fixture = requirementFixture();
    fixture.features[0].requirement.platforms.linux = value;
    assert.match(requirementErrors(fixture).join("\n"), /operation: linux platform/);
  }
});

test("requirement scenario references cannot use an implementation file as a test", () => {
  const fixture = requirementFixture();
  fixture.features[0].tests[0].file = "unit.js";
  fixture.features[0].tests[0].id = "run";
  assert.match(requirementErrors(fixture).join("\n"), /scenario reference is not a discovered test file/);
});

test("requirement audit permits justified inapplicability only for race and recovery", () => {
  for (const dimension of ["normal", "failure"]) {
    const fixture = requirementFixture();
    fixture.features[0].requirement.inapplicable[dimension] = "No asynchronous state is retained.";
    fixture.features[0].tests[0].covers = fixture.features[0].tests[0].covers.filter((value) => value !== dimension);
    assert.match(requirementErrors(fixture).join("\n"), /normal and failure require owning tests/);
  }
  for (const reason of ["", " "]) {
    const fixture = requirementFixture();
    fixture.features[0].requirement.inapplicable.race = reason;
    fixture.features[0].tests[0].covers = ["normal", "failure", "recovery"];
    assert.match(requirementErrors(fixture).join("\n"), /operation: race inapplicability requires a reason/);
  }
  const fixture = requirementFixture();
  fixture.features[0].tests[0].covers = ["normal", "failure"];
  fixture.features[0].requirement.inapplicable = {
    race: "The operation validates an immutable value synchronously without shared state.",
    recovery: "A refusal retains no state; each new value is validated independently.",
  };
  fixture.features[0].requirement.platforms.linux = { status: "unavailable",
    reason: "No capture backend is implemented on Linux.", resumeWhen: "Implement and verify the Linux capture backend." };
  assert.deepEqual(requirementErrors(fixture), []);
});

test("requirement scope rejects missing rows, duplicates and translation drift", () => {
  const scope = ["<!-- requirement-scope:start -->", "| Key | Contract |", "| --- | --- |",
    "| `first` | First contract. |", "| `second` | Second contract. |", "<!-- requirement-scope:end -->"].join("\n");
  assert.deepEqual(readRequirementScope(scope, scope), ["first", "second"]);
  assert.throws(() => readRequirementScope("", scope), /marker pair/);
  assert.throws(() => readRequirementScope(scope + scope, scope), /marker pair/);
  assert.throws(() => readRequirementScope(scope.replace("`second`", "`first`"), scope), /unique named rows/);
  assert.throws(() => readRequirementScope(scope.replace("Second contract.", " "), scope), /nonempty contracts/);
  assert.throws(() => readRequirementScope(scope, scope.replace("| `second` | Second contract. |\n", "")), /keys and order differ/);
});

test("requirement reports keep mapped scenarios and unavailable platforms explicitly unverified", () => {
  const fixture = requirementFixture();
  fixture.features[0].requirement.platforms.win32 = { status: "unavailable",
    reason: "The native backend is not implemented.", resumeWhen: "Implement and verify the native backend." };
  const report = auditRequirementCoverage(fixture.features, fixture.scope);
  assert.deepEqual(report.errors, []);
  assert.ok(Object.values(report.rows[0].dimensions).every((value) => value.status === "mapped" && value.executed === false));
  assert.ok(Object.values(report.rows[0].platforms).every((value) => value.verified === false));
  const summary = requirementSummary(report);
  assert.match(summary, /mapped tests were not executed/);
  assert.match(summary, /darwin=required\/unverified/);
  assert.match(summary, /win32=unavailable\/unverified \(The native backend is not implemented.; resume: Implement and verify the native backend.\)/);
  assert.doesNotMatch(summary, /\d+%|acceptance passed/);
});

test("the inventory enforces every declared requirement through its existing owning links", () => {
  const inventory = auditInventory(files);
  assert.deepEqual(inventory.requirementCoverage.errors, []);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const read = (file) => readFileSync(join(root, file), "utf8");
  const keys = readRequirementScope(read("docs/spec/verification.md"), read("docs/spec/verification.ko.md"));
  assert.deepEqual(inventory.requirementCoverage.rows.map(({ key }) => key).sort(), [...keys].sort());
  for (const key of keys) {
    const feature = structuredClone(inventory.featureLinks.find((entry) => entry.requirement?.key === key));
    assert.deepEqual(auditFeatureLinks([feature], files, read, { requirementScope: [key] }), [], key);
    for (const test of feature.tests) if (test.covers) test.covers = test.covers.filter((dimension) => dimension !== "normal");
    assert.match(auditFeatureLinks([feature], files, read, { requirementScope: [key] }).join("\n"), new RegExp(`${key}: missing normal scenario`));
  }
  const missingScope = auditInventory(files, undefined, (file) => file === "docs/spec/verification.md" ? "" : read(file));
  assert.ok(missingScope.errors.some((error) => error.includes("cannot read requirement scope")));
});

test("the package index holds only the packages of this checkout and reads no declared repository", (t) => {
  // A CI job checks out only core, so a declared repository folder such as ../plugins/probe does not exist beside it.
  const away = mkdtempSync(join(tmpdir(), "soksak-parity-index-"));
  const previous = process.cwd();
  process.chdir(away);
  t.after(() => {
    process.chdir(previous);
    rmSync(away, { recursive: true, force: true });
  });
  const index = packageIndex();
  assert.ok(index.has("@soksak/plugin-api"));
  assert.deepEqual([...index.values()].filter((entry) => entry.dir.startsWith("..") || entry.dir.startsWith("/")), []);
});

test("language coverage audit rejects missing and extra adapter languages", () => {
  assert.deepEqual(auditExecutableLanguageCoverage(["src/app.rs", "scripts/check.sh"], ["rust"]), [
    "executable implementation language shell has no language adapter test case",
  ]);
  assert.deepEqual(auditExecutableLanguageCoverage(["src/app.rs", "scripts/check.sh"], ["rust", "shell", "go"]), [
    "language adapter declares go but no executable implementation uses it",
  ]);
  assert.deepEqual(auditExecutableLanguageCoverage(["src/app.rs", "scripts/check.sh", "docs/page.html", "ui/main.css"], ["rust", "shell"]), []);
});

for (const file of [
  "packages/host/wailsv3/src/platform/darwin/uncovered.m",
  "sidecars/vt-core/src/platform/darwin/uncovered.m",
  "packages/new-component/src/new.rs",
  "scripts/uncovered.mjs",
  "packages/new-component/tests/new_test.rs",
  "plugins/new-plugin/plugin.json",
]) {
  test(`inventory rejects an unmapped workspace file: ${file}`, { timeout: 1000 }, () => {
    const result = auditInventory([...files, file]);
    assert.ok(result.errors.some((error) => error.includes(file)), `audit silently omitted ${file}`);
  });
}

test("inventory rejects an empty test lane", { timeout: 1000 }, () => {
  const result = auditInventory(["unit.js"], [{ capability: "unit", language: "js-ts", implementation: ["unit.js"], tests: [] }]);
  assert.ok(result.errors.some((error) => error.includes("no test files")));
});

test("inventory accepts Makefile build declarations and rejects other build files", { timeout: 1000 }, () => {
  const lane = (implementation) => [{ capability: "build", language: "build", implementation: [implementation], tests: ["unit.test.mjs"], testLanguage: "js-ts" }];
  const invalid = (result) => result.errors.filter((error) => error.includes("implementation extension is not valid"));
  assert.deepEqual(invalid(auditInventory(["native/Makefile", "unit.test.mjs"], lane("native/Makefile"))), []);
  assert.equal(invalid(auditInventory(["build.js", "unit.test.mjs"], lane("build.js"))).length, 1);
  assert.deepEqual(invalid(auditInventory(files)), []);
});

test("boundary audit rejects a duplicate implementation and test owner", { timeout: 1000 }, () => {
  const result = auditInventory(["unit.js", "unit.test.mjs"], [
    { capability: "first", language: "js-ts", implementation: ["unit.js"], tests: ["unit.test.mjs"] },
    { capability: "duplicate", language: "js-ts", implementation: ["unit.js"], tests: ["unit.test.mjs"] },
  ]);
  assert.ok(result.errors.some((error) => error.includes("implementation is claimed by multiple")));
  assert.ok(result.errors.some((error) => error.includes("test is claimed by multiple")));
});

test("inventory rejects a file that a list of one lane repeats", { timeout: 1000 }, () => {
  const lane = (implementation, tests) => [{ capability: "unit", language: "js-ts", implementation, tests }];
  const repeated = (result) => result.errors.filter((error) => error.includes("repeats"));
  assert.deepEqual(repeated(auditInventory(["unit.js", "unit.test.mjs"], lane(["unit.js"], ["unit.test.mjs", "unit.test.mjs"]))), [
    "unit.test.mjs: unit repeats this test: unit.test.mjs, unit.test.mjs",
  ]);
  assert.deepEqual(repeated(auditInventory(["src/unit.js", "unit.test.mjs"], lane(["src/*.js", "src/unit.js"], ["unit.test.mjs"]))), [
    "src/unit.js: unit repeats this implementation: src/*.js, src/unit.js",
  ]);
  assert.deepEqual(repeated(auditInventory(["unit.js", "unit.test.mjs"], lane(["unit.js"], ["unit.test.mjs"]))), []);
});

test("inventory rejects duplicated ownership", { timeout: 1000 }, () => {
  const lane = { capability: "unit", language: "js-ts", implementation: ["unit.js"], tests: ["unit.test.mjs"] };
  const result = auditInventory(["unit.js", "unit.test.mjs"], [lane, { ...lane, capability: "other" }]);
  assert.ok(result.errors.some((error) => error.includes("multiple matrix entries")));
});

test("shared tests do not permit duplicate implementation ownership", { timeout: 1000 }, () => {
  const lane = { capability: "unit", language: "js-ts", implementation: ["unit.js"], tests: ["unit.test.mjs"], sharedTests: true };
  const result = auditInventory(["unit.js", "unit.test.mjs"], [lane, { ...lane, capability: "other" }]);
  assert.ok(result.errors.some((error) => error.includes("unit.js: implementation is claimed by multiple")));
});

test("discovery includes nested languages and manifests without a registered root", { timeout: 1000 }, () => {
  const result = discoverInventory([
    "new/Cargo.toml", "new/go.mod", "new/package.json", "new/Makefile",
    "new/src/bridge.m", "new/src/main.rs", "new/src/bridge.js", "new/src/main.go",
    "new/tests/bridge_test.m", "new/tests/bridge_test.m",
  ]);
  assert.equal(result.manifests.length, 4);
  assert.deepEqual(result.implementations.map((entry) => entry.language).sort(), ["go", "js-ts", "objective-c", "rust"]);
  assert.equal(result.tests.length, 1);
});

test("generated exclusions are explicit and do not exclude another package's dist sources", { timeout: 1000 }, () => {
  const result = discoverInventory(["packages/soksak/dist/index.js", "new/dist/original.js"]);
  assert.deepEqual(result.implementations, [{ file: "new/dist/original.js", language: "js-ts" }]);
  assert.equal(result.generated.length, 1);
  assert.match(result.generated[0].reason, /make test-all/);
});

test("inventory reports uncovered implementations and tests as separate results", { timeout: 1000 }, () => {
  const result = auditInventory(["orphan.js", "orphan.test.mjs"], []);
  assert.deepEqual(result.uncoveredImplementations, [{ file: "orphan.js", language: "js-ts" }]);
  assert.deepEqual(result.uncoveredTests, [{ file: "orphan.test.mjs", language: "js-ts" }]);
  assert.ok(result.errors.some((error) => error.includes("orphan.js")));
  assert.ok(result.errors.some((error) => error.includes("orphan.test.mjs")));
});

test("feature links reject missing evidence fields and workspace files", { timeout: 1000 }, () => {
  const errors = auditFeatureLinks([
    {
      id: "broken",
      implementation: [
        { file: "missing.js", symbol: "run" },
        { file: "known.js", symbol: "absent" },
      ],
      tests: [
        { file: "missing.test.mjs", id: "runs" },
        { file: "known.test.mjs", id: "absent test" },
      ],
      expected: "",
      levels: ["unknown"],
    },
  ], ["known.js", "known.test.mjs"], () => "function run() {}\n");
  assert.ok(errors.some((error) => error.includes("no expected result")));
  assert.ok(errors.some((error) => error.includes("invalid verification level")));
  assert.ok(errors.some((error) => error.includes("missing.js")));
  assert.ok(errors.some((error) => error.includes("missing.test.mjs")));
  assert.ok(errors.some((error) => error.includes("implementation symbol is not present")));
  assert.ok(errors.some((error) => error.includes("behavior test id is not present")));
});

test("evidence audit rejects attribution to the wrong behavior-test file", { timeout: 1000 }, () => {
  const errors = auditFeatureLinks([
    {
      id: "wrong-attribution",
      implementation: [{ file: "known.js", symbol: "run" }],
      tests: [{ file: "other.test.mjs", id: "runs the known behavior" }],
      expected: "The named behavior is executed and observed.",
      levels: ["unit"],
    },
  ], ["known.js", "other.test.mjs"], (file) => file === "known.js" ? "export function run() {}\n" : "test('different behavior', () => {});\n");
  assert.ok(errors.some((error) => error.includes("behavior test id is not present in other.test.mjs")));
});

test("feature-link audit self-check detects an omitted error and response", { timeout: 10000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "soksak-audit-mutations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "scripts");
  mkdirSync(directory);
  // Import the real audit module from an isolated copy. Its unchanged dependency
  // remains at its owning path; no implementation is extracted or re-created.
  for (const dependency of ["check-boundaries.mjs", "checklist.mjs"]) {
    symlinkSync(fileURLToPath(new URL(`../${dependency}`, import.meta.url)), join(directory, dependency));
  }
  const original = readFileSync(new URL("../check-tests.mjs", import.meta.url), "utf8");
  const candidate = join(directory, "check-tests.mjs");
  const check = join(root, "check.mjs");
  writeFileSync(check, [
    'import assert from "node:assert/strict";',
    `import { auditFeatureLinks } from ${JSON.stringify(pathToFileURL(candidate).href)};`,
    'const feature = { id: "required", expected: "", levels: ["unit"], implementation: [{ file: "unit.js", symbol: "run" }], tests: [{ file: "unit.test.mjs", id: "observes run" }] };',
    `const source = (file) => file === "unit.js" ? ${JSON.stringify("export function run() {}")} : ${JSON.stringify('test("observes run", () => {});')};`,
    'assert.deepEqual(auditFeatureLinks([feature], ["unit.js", "unit.test.mjs"], source), ["required: feature link has no expected result"]);',
  ].join("\n"));
  const run = (source) => {
    writeFileSync(candidate, source);
    return spawnSync(process.execPath, [check], { encoding: "utf8", timeout: 3000 });
  };
  const baseline = run(original);
  assert.equal(baseline.error, undefined);
  assert.equal(baseline.status, 0, baseline.stderr);
  for (const [name, before, after] of [
    ["error effect", 'if (!feature.expected?.trim()) errors.push(`${feature.id}: feature link has no expected result`);', 'if (!feature.expected?.trim()) {}'],
    ["error response", "  return errors;\n}\n\n// Aggregate review records", "  return undefined;\n}\n\n// Aggregate review records"],
  ]) {
    assert.equal(original.split(before).length - 1, 1, `${name}: mutation must match exactly once`);
    const result = run(original.replace(before, after));
    assert.equal(result.error, undefined, `${name}: command could not run`);
    assert.equal(result.signal, null, `${name}: command was interrupted`);
    assert.equal(result.status, 1, `${name}: audit defect escaped its assertion\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /ERR_ASSERTION/, `${name}: an execution error is not an audit assertion`);
  }
});

test("completed capability entries all have feature evidence links", { timeout: 1000 }, () => {
  const inventory = auditInventory(files);
  assert.deepEqual(auditCompletedFeatureLinks(inventory.featureLinks), []);
  assert.ok(!inventory.featureLinks.some((feature) => feature.id === "G1.4-2"));
  assert.ok(!inventory.featureLinks.some((feature) => feature.id === "V3"));
});

test("completed audit aggregates and fixture corrections are exempt while unlinked product capabilities need feature links", { timeout: 1000 }, () => {
  assert.deepEqual(
    auditCompletedFeatureLinks([], "- [o] F13 — aggregate\n- [o] F266 — audit\n- [o] F267 — audit\n- [o] F239-47-5 — fixture correction\n- [o] F239-47-34 — documentation correction\n- [o] F239-195 — candidate package installation\n- [o] F239-198 — candidate package installation\n- [o] F239-47-30-4 — historical source audit\n- [o] F239-199 — inventory metadata\n- [o] X1 — capability\n"),
    ["X1: completed capability has no feature link"],
  );
});

test("inventory totals follow declared test additions without copied documentation", { timeout: 1000 }, () => {
  const matrix = [{ capability: "unit", language: "js-ts", implementation: ["unit.js"], tests: ["*.test.mjs"], testLanguage: "js-ts" }];
  const original = auditInventory(["unit.js", "first.test.mjs"], matrix, () => "");
  const added = auditInventory(["unit.js", "first.test.mjs", "second.test.mjs"], matrix, () => "");
  const checklist = "- [ ] F1 — pending\n  - [~] F1-1 — executing\n- [o] F2 — complete\n";
  assert.match(inventorySummary(original, checklist), /^1 tracks, 1 implementation files, 1 test files\./);
  assert.match(inventorySummary(added, checklist), /^1 tracks, 1 implementation files, 2 test files\./);
  assert.match(inventorySummary(added, checklist), /1 waiting, 1 active, 0 held, 1 complete, 0 closed \(3 total/);
  assert.deepEqual(added.uncoveredImplementations, []);
  assert.deepEqual(added.uncoveredTests, []);
  assert.match(inventorySummary(added, checklist), /Structural evidence only; behavior was not executed/);
});

// The names are joined from parts: the boundary audit scans this file for @soksak/ names.
const scoped = (name) => ["@soksak", name].join("/");
// The package index of the fixtures: the packages that the cases name, with their owners and exports maps.
const declared = new Map([
  [scoped("plugin-api"), { dir: "packages/plugin-api", owner: "core", exports: { ".": "./index.js", "./view": "./view.js" } }],
  [scoped("plugin-probe"), { dir: "/elsewhere/plugins/probe", owner: "plugin" }],
  [scoped("sidecar-probe"), { dir: "/elsewhere/sidecars/probe", owner: "sidecar" }],
  [scoped("sidecar-y"), { dir: "/elsewhere/sidecars/y", owner: "sidecar" }],
]);

test("ownership audit rejects cross-owner implementation names and private paths", { timeout: 1000 }, () => {
  const result = auditOwnership([
    "plugins/example/ui/module.js",
    "plugins/example/plugin.json",
    "sidecars/example/src/main.go",
    "packages/example/src/index.js",
    "plugins/example/test/module.test.mjs",
  ], (file) => ({
    "plugins/example/ui/module.js": `import "${scoped("sidecar-y")}";\nimport "sidecars/example/src/main.go";\n`,
    "plugins/example/plugin.json": `{"sidecars":["${scoped("sidecar-y")}"]}`,
    "sidecars/example/src/main.go": "package main\n",
    "packages/example/src/index.js": 'import "plugins/example/ui/module.js";\n',
    "plugins/example/test/module.test.mjs": 'import "sidecars/example/src/main.go";\n',
  }[file] ?? ""), declared);
  assert.ok(result.some((error) => error.includes("plugins/example/ui/module.js") && error.includes("sidecar")));
  assert.ok(result.some((error) => error.includes("packages/example/src/index.js") && error.includes("plugin")));
  assert.ok(result.some((error) => error.includes("plugins/example/test/module.test.mjs") && error.includes("private")));
  assert.ok(!result.some((error) => error.includes("plugin.json")), "declaration files must connect owners");
});

test("ownership audit classifies only declared names, by exact name", { timeout: 1000 }, () => {
  const errors = auditOwnership([
    "packages/example/index.js",
    "packages/example/api.js",
  ], (file) => file.endsWith("index.js")
    ? `import "${scoped("plugin-probe")}";\nimport "${scoped("sidecar-probe")}";\nimport "${scoped("plugin-undeclared")}";\n`
    : `import "${scoped("plugin-api")}";\n`, declared);
  assert.deepEqual(errors, [
    `packages/example/index.js: core implementation names plugin implementation ${scoped("plugin-probe")}`,
    `packages/example/index.js: core implementation names sidecar implementation ${scoped("sidecar-probe")}`,
    `packages/example/index.js: core implementation names undeclared package ${scoped("plugin-undeclared")}`,
  ]);
});

test("ownership audit refuses an undeclared package in plugin and sidecar code", { timeout: 1000 }, () => {
  const errors = auditOwnership([
    "plugins/example/ui/a.js",
    "sidecars/example/src/b.js",
  ], () => `import "${scoped("plugin-undeclared")}";\n`, declared);
  assert.deepEqual(errors, [
    `plugins/example/ui/a.js: plugin implementation names undeclared package ${scoped("plugin-undeclared")}`,
    `sidecars/example/src/b.js: sidecar implementation names undeclared package ${scoped("plugin-undeclared")}`,
  ]);
});

test("ownership audit fails a plugin that names a declared sidecar or a private path", { timeout: 1000 }, () => {
  const index = new Map([
    ...declared,
    [scoped("sidecar-y"), { dir: "/elsewhere/sidecars/y", owner: "sidecar" }],
  ]);
  const errors = auditOwnership([
    "apps/x/a.js",
    "e2e/a.test.mjs",
    "plugins/x/ui/a.js",
  ], (file) => file === "plugins/x/ui/a.js"
    ? `import "${scoped("sidecar-y")}";\nimport "${scoped("plugin-api")}";\nimport "${scoped("plugin-api")}/src/private.js";\n`
    : `import "${scoped("plugin-api")}/src/private.js";\n`,
  index);
  assert.deepEqual(errors, [
    `apps/x/a.js: application implementation reads private path ${scoped("plugin-api")}/src/private.js`,
    `e2e/a.test.mjs: contract test reads private path ${scoped("plugin-api")}/src/private.js`,
    `plugins/x/ui/a.js: plugin implementation names sidecar implementation ${scoped("sidecar-y")}`,
    `plugins/x/ui/a.js: plugin implementation reads private path ${scoped("plugin-api")}/src/private.js`,
  ]);
});

test("ownership audit refuses a core source that names an undeclared package", { timeout: 1000 }, () => {
  const errors = auditOwnership(["packages/x/a.js"], () => `import "${scoped("probeplain")}";\n`, declared);
  assert.deepEqual(errors, [`packages/x/a.js: core implementation names undeclared package ${scoped("probeplain")}`]);
});

test("ownership audit allows a subpath only when the exports map lists it or the package is its own", { timeout: 1000 }, () => {
  const index = new Map([
    ...declared,
    [scoped("runtime"), { dir: "packages/runtime", owner: "core", exports: { ".": "./index.js", "./lib/*.js": "./lib/*.js" } }],
    [scoped("bare"), { dir: "packages/bare", owner: "core" }],
  ]);
  const errors = auditOwnership([
    "packages/plugin-api/own.js",
    "packages/app/use.js",
  ], (file) => file.endsWith("own.js")
    ? `import "${scoped("plugin-api")}/src/private.js";\nimport "${scoped("plugin-api")}/view";\n`
    : `import "${scoped("runtime")}/lib/x.js";\nimport "${scoped("runtime")}/src/x.js";\nimport "${scoped("bare")}/lib/x.js";\nimport "${scoped("bare")}";\n`,
  index);
  assert.deepEqual(errors, [
    `packages/app/use.js: core implementation reads private path ${scoped("runtime")}/src/x.js`,
    `packages/app/use.js: core implementation reads private path ${scoped("bare")}/lib/x.js`,
  ]);
});

test("ownership audit finds a bare require.resolve reference with a private subpath", { timeout: 1000 }, () => {
  // The runtime is a core package outside the plugin prefixes, so only the bare require.resolve form finds it.
  const index = new Map([
    ...declared,
    [scoped("runtime"), { dir: "packages/runtime", owner: "core", exports: { ".": "./index.js" } }],
  ]);
  const errors = auditOwnership([
    "plugins/example/ui/module.js",
    "plugins/example/ui/view.js",
  ], (file) => file.endsWith("module.js")
    ? `const p = require.resolve("${scoped("runtime")}/src/x.js");\n`
    : `const v = require.resolve("${scoped("plugin-api")}/view");\n`,
  index);
  assert.deepEqual(errors, [
    `plugins/example/ui/module.js: plugin implementation reads private path ${scoped("runtime")}/src/x.js`,
  ]);
});

test("ownership audit does not authorize private access through a declared dependency", { timeout: 1000 }, () => {
  const errors = auditOwnership([
    "plugins/example/ui/module.js",
    "sidecars/example/src/main.go",
  ], (file) => file.endsWith("module.js")
    ? `import "${scoped("sidecar-y/src/private.js")}";\n`
    : "package main\n", declared);
  assert.ok(errors.some((error) => error.includes("private")));
});

test("JS failure audit rejects promise handlers that hide rejection", { timeout: 1000 }, () => {
  const errors = auditJsFailurePropagation([
    "packages/example/empty.js",
    "packages/example/undefined.js",
    "packages/example/visible.js",
    "packages/example/test/example.test.mjs",
  ], (file) => ({
    "packages/example/empty.js": "work().catch(() => {});",
    "packages/example/undefined.js": "work().catch(() => undefined);",
    "packages/example/visible.js": "work().catch((error) => report(error));",
    "packages/example/test/example.test.mjs": "work().catch(() => {});",
  }[file] ?? ""));
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.includes("hides a rejected operation")));
});

test("a window check joins several errors only through joinedFailure, so a failure names every cause", { timeout: 1000 }, () => {
  const sources = {
    "packages/window-check/failure.mjs": "export function joinedFailure(label, errors) { return new AggregateError(errors, label); }",
    "packages/window-check/app.mjs": "throw new AggregateError(failures, \"cleanup failed\");",
    "e2e/capture.test.mjs": "if (a && b) throw new  AggregateError([a, b], `check failed`);",
    "e2e/test/fixture.test.mjs": "assert.ok(failure instanceof AggregateError);",
    "e2e/joined.test.mjs": "throw joinedFailure(\"check failed\", [a, b]);",
    "packages/other/src/index.mjs": "throw new AggregateError(errors, \"other package\");",
  };
  const errors = auditJoinedFailures(Object.keys(sources), (file) => sources[file]);
  assert.deepEqual(errors, [
    "e2e/capture.test.mjs:1: new AggregateError drops the messages of its errors from the report; throw joinedFailure (packages/window-check/failure.mjs)",
    "packages/window-check/app.mjs:1: new AggregateError drops the messages of its errors from the report; throw joinedFailure (packages/window-check/failure.mjs)",
  ]);
  assert.ok(auditFailureMatrix(Object.keys(sources), (file) => sources[file]).errors
    .includes("js-ts: packages/window-check/app.mjs:1: new AggregateError drops the messages of its errors from the report; throw joinedFailure (packages/window-check/failure.mjs)"));
});

test("a test source creates its temporary folders and files in TMPDIR, not under a fixed temporary path", { timeout: 1000 }, () => {
  // The fixed roots are joined at run time, so this source itself names none of them.
  const [tmp, privateTmp, folders] = [["", "tmp"], ["", "private", "tmp"], ["", "var", "folders"]].map((parts) => parts.join("/"));
  const sources = {
    "native/darwin/tests/capture_test.m": `char directory[] = "${tmp}/soksak-capture-test-XXXXXX";\nmkdtemp(directory);`,
    "native/darwin/tests/log_test.m": `char path[] = "${privateTmp}/log.XXXXXX";`,
    "native/darwin/tests/kept_test.m": `NSString *folder = temporaryFolder(@"soksak-kept-");`,
    "native/darwin/tests/support/temporary_folder.m": "if (mkdtemp(path) == NULL) {",
    "native/darwin/tests/clipboard_test.m": `[NSURL fileURLWithPath:@"${tmp}/soksak-a"]`,
    "packages/sok/go/tests/sok_test.go": `socketDir, err := os.MkdirTemp("${tmp}", "sok")`,
    "packages/sok/go/tests/other_test.go": `socketDir, err := os.MkdirTemp("", "sok")`,
    "packages/sok/rust/tests/sok_test.rs": `let socket = Folder::new_in(Path::new("${tmp}"), "socket");`,
    "e2e/fixtures/sidecars/probe/src/server.rs": `let template = CString::new("${tmp}/probe.XXXXXX");`,
    "e2e/test/run.test.mjs": `const directory = mkdtempSync(join("${folders}", "run-"));\nconst env = { SOKSAK_RUN_FOLDER: "${tmp}/run folder" };`,
    "packages/other/src/index.mjs": `const directory = mkdtempSync("${tmp}/other-");`,
  };
  const refused = (file, name) => `${file}:1: ${name}; create it in TMPDIR, which the test runner removes`;
  assert.deepEqual(auditFixedTemporaryPaths(Object.keys(sources), (file) => sources[file]), [
    refused("e2e/fixtures/sidecars/probe/src/server.rs", "a temporary template under a fixed path"),
    refused("e2e/test/run.test.mjs", "a temporary entry created under a fixed path"),
    refused("native/darwin/tests/capture_test.m", "a temporary template under a fixed path"),
    refused("native/darwin/tests/log_test.m", "a temporary template under a fixed path"),
    refused("packages/sok/go/tests/sok_test.go", "a temporary entry created under a fixed path"),
    refused("packages/sok/rust/tests/sok_test.rs", "a temporary entry created under a fixed path"),
  ]);
});

test("Rust failure audit rejects ignored outcomes in the scoped production lane", { timeout: 1000 }, () => {
  const errors = auditRustFailurePropagation([
    "packages/sok/rust/src/registry.rs",
    "packages/sok/rust/src/platform/path.rs",
    "packages/sok/rust/tests/registry_test.rs",
    "packages/host/tauriv2/src/ignored.rs",
  ], (file) => ({
    "packages/sok/rust/src/registry.rs": "let _ = actor.await;",
    "packages/sok/rust/src/platform/path.rs": "let result = work();",
    "packages/sok/rust/tests/registry_test.rs": "let _ = serve(...);",
    "packages/host/tauriv2/src/ignored.rs": "let _ = host();",
  }[file] ?? ""), "packages/sok/rust/src/");
  assert.deepEqual(errors, ["packages/sok/rust/src/registry.rs:1: ignored Rust result or task outcome"]);
  assert.deepEqual(auditRustFailurePropagation([
    "packages/host/tauriv2/src/ignored.rs",
    "packages/host/tauriv2/tests/ignored.rs",
  ], (file) => file.endsWith("ignored.rs") ? "let _ = host();" : "", "packages/host/tauriv2/src/"), [
    "packages/host/tauriv2/src/ignored.rs:1: ignored Rust result or task outcome",
  ]);
});

test("Rust failure audit covers every production lane", { timeout: 1000 }, () => {
  const files = [
    "packages/host/rust/src/host.rs",
    "packages/host/tauriv2/src/host.rs",
    "packages/sok/rust/src/sok.rs",
    "apps/tauriv2/src/main.rs",
    "packages/other/src/other.rs",
  ];
  const rust = auditFailureMatrix(files, () => "let _ = host();").lanes.find((lane) => lane.language === "rust");
  assert.deepEqual(rust.errors, [
    "packages/host/rust/src/host.rs:1: ignored Rust result or task outcome",
    "packages/host/tauriv2/src/host.rs:1: ignored Rust result or task outcome",
    "packages/sok/rust/src/sok.rs:1: ignored Rust result or task outcome",
    "apps/tauriv2/src/main.rs:1: ignored Rust result or task outcome",
  ]);
});

test("Darwin native failure audit rejects log-only capture boundaries", { timeout: 1000 }, () => {
  const files = [
    "native/darwin/src/capture.h",
    "native/darwin/src/capture.m",
    "packages/host/rust/src/platform/darwin/capture.rs",
  ];
  const sources = new Map([
    [files[0], "void sp_capture_open(long windowNumber, bool display);"],
    [files[1], "void sp_capture_start(const char *directory);"],
    [files[2], "let Ok(value) = CString::new(input) else { return; };"],
  ]);
  assert.equal(auditNativeFailurePropagation(files, (file) => sources.get(file)).length, 6);
});

test("Darwin native failure audit accepts explicit capture results", { timeout: 1000 }, () => {
  const files = [
    "native/darwin/src/capture.h",
    "native/darwin/src/capture.m",
    "packages/host/rust/src/platform/darwin/capture.rs",
  ];
  const sources = new Map([
    [files[0], "bool sp_capture_open(long windowNumber, bool display); const char *sp_capture_error(void);"],
    [files[1], "bool sp_capture_open(long windowNumber, bool display); bool sp_capture_start(const char *directory);"],
    [files[2], "fn sp_capture_open(value: isize, display: bool) -> bool { true } fn sp_capture_start(value: *const c_char) -> bool { true } extern { fn sp_capture_error(); }"],
  ]);
  assert.deepEqual(auditNativeFailurePropagation(files, (file) => sources.get(file)), []);
});

test("Go failure audit rejects ignored results in every Go production lane", { timeout: 1000 }, () => {
  const files = [
    "packages/host/wailsv3/src/host.go",
    "packages/sok/go/src/sok.go",
    "packages/host/wailsv3/tests/ignored_test.go",
  ];
  const sources = new Map([
    [files[0], "data, _ = json.Marshal(value)"],
    [files[1], "if err := command.Close(); err != nil { report(err) }"],
    [files[2], "_ = ignored()"],
  ]);
  assert.deepEqual(auditGoFailurePropagation(files, (file) => sources.get(file)), [
    "packages/host/wailsv3/src/host.go:1: ignored Go result or fallback encoding",
  ]);
});

test("failure matrix preserves JS/TS, Rust, Go, and Objective-C lane attribution", { timeout: 1000 }, () => {
  const matrix = auditFailureMatrix(repositoryFiles());
  assert.deepEqual(matrix.lanes.map(({ language }) => language), ["js-ts", "rust", "go", "objective-c"]);
  assert.deepEqual(matrix.errors, []);
});

const WORKBENCH_SPEC = "## Contract cases\n\n| `host.case` | x | all |\n\n## Workbench cases\n\n| Case | Behavior |\n| --- | --- |\n| `area.shared` | x |\n";

test("a workbench case with a page test and a mygo test passes, and a host case of a page test does not count", () => {
  assert.deepEqual(auditWorkbenchCases(WORKBENCH_SPEC, [
    { path: "packages/workbench/test/a.test.mjs", text: "// contract: host.case\ntest(\"host\", () => {});\n// contract: area.shared\ntest(\"page\", () => {});\n" },
    { path: "packages/workbench-mygo/tests/a_test.go", text: "// contract: area.shared\nfunc TestShared(t *testing.T) {\n}\n" },
  ]), []);
});

test("a workbench case without a test on one side fails, and names the side", () => {
  assert.deepEqual(auditWorkbenchCases(WORKBENCH_SPEC, [
    { path: "packages/workbench/test/a.test.mjs", text: "// contract: area.shared\ntest(\"page\", () => {});\n" },
  ]), ["docs/spec/host-contract.md: workbench case area.shared has no mygo test"]);
  assert.deepEqual(auditWorkbenchCases(WORKBENCH_SPEC, [
    { path: "packages/workbench-mygo/tests/a_test.go", text: "// contract: area.shared\nfunc TestShared(t *testing.T) {\n}\n" },
  ]), ["docs/spec/host-contract.md: workbench case area.shared has no page test"]);
});

test("a mygo test of a case that the table does not have, and a declaration on no test, fail", () => {
  assert.deepEqual(auditWorkbenchCases(WORKBENCH_SPEC, [
    { path: "packages/workbench/test/a.test.mjs", text: "// contract: area.shared\nconst helper = 1;\n// contract: area.shared\ntest(\"page\", () => {});\n" },
    { path: "packages/workbench-mygo/tests/a_test.go", text: "// contract: area.other\nfunc TestOther(t *testing.T) {\n}\n// contract: area.shared\nfunc TestShared(t *testing.T) {\n}\n" },
  ]), [
    "packages/workbench/test/a.test.mjs:1: the declaration of area.shared is not attached to a test",
    "packages/workbench-mygo/tests/a_test.go:1: workbench case area.other is not in docs/spec/host-contract.md",
  ]);
});

test("a specification without the section of workbench cases fails", () => {
  assert.deepEqual(auditWorkbenchCases("## Contract cases\n", []), ["docs/spec/host-contract.md has no \"Workbench cases\" section"]);
});
