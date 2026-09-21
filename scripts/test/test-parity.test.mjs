import assert from "node:assert/strict";
import test from "node:test";
import { auditCommittedEvidenceWording, auditCompletedFeatureLinks, auditFeatureLinks, auditHistoricalScopeWording, auditInventory, auditModalParitySnapshotWording, auditOwnership, auditRecordedInventoryCounts, discoverInventory, repositoryFiles } from "../check-test-parity.mjs";

const files = repositoryFiles();

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
  assert.match(result.generated[0].reason, /make verify/);
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

test("completed capability entries all have feature evidence links", { timeout: 1000 }, () => {
  const inventory = auditInventory(files);
  assert.deepEqual(auditCompletedFeatureLinks(inventory.featureLinks), []);
  assert.ok(!inventory.featureLinks.some((feature) => feature.id === "G1.4-2"));
});

test("recorded parity counts cannot drift from the current inventory", { timeout: 1000 }, () => {
  const inventory = auditInventory(files);
  assert.deepEqual(auditRecordedInventoryCounts(inventory), []);
  assert.match(
    auditRecordedInventoryCounts({ ...inventory, testCount: inventory.testCount + 1 })[0],
    /do not match current output/,
  );
});

test("completed F3 scope is not reported as currently open", { timeout: 1000 }, () => {
  assert.deepEqual(auditHistoricalScopeWording(), []);
  assert.match(
    auditHistoricalScopeWording("Controlled-site pixels and restored/new-document validation remain open under F3." )[0],
    /currently open/,
  );
});

test("modal parity Red is dated and followed by current F10.2 evidence", { timeout: 1000 }, () => {
  assert.deepEqual(auditModalParitySnapshotWording(), []);
  assert.match(
    auditModalParitySnapshotWording("The modal implementation has a larger confirmed gap." )[0],
    /historical snapshot/,
  );
});

test("F0.1 evidence identifies its committed build", { timeout: 1000 }, () => {
  assert.deepEqual(auditCommittedEvidenceWording(), []);
  assert.match(
    auditCommittedEvidenceWording("- [o] F0.1 — Unblock native input measurement. Package and structural checks pass on the current dirty implementation.")[0],
    /current dirty implementation/,
  );
});

test("ownership audit rejects cross-owner implementation names and private paths", { timeout: 1000 }, () => {
  const result = auditOwnership([
    "plugins/example/ui/module.js",
    "plugins/example/plugin.json",
    "sidecars/example/src/main.go",
    "packages/example/src/index.js",
    "plugins/example/test/module.test.mjs",
  ], (file) => ({
    "plugins/example/ui/module.js": 'import "@soksak/sidecar-example";\nimport "sidecars/example/src/main.go";\n',
    "plugins/example/plugin.json": '{"sidecars":["@soksak/sidecar-example"]}',
    "sidecars/example/src/main.go": "package main\n",
    "packages/example/src/index.js": 'import "plugins/example/ui/module.js";\n',
    "plugins/example/test/module.test.mjs": 'import "sidecars/example/src/main.go";\n',
  }[file] ?? ""));
  assert.ok(result.some((error) => error.includes("plugins/example/ui/module.js") && error.includes("sidecar")));
  assert.ok(result.some((error) => error.includes("packages/example/src/index.js") && error.includes("plugin")));
  assert.ok(result.some((error) => error.includes("plugins/example/test/module.test.mjs") && error.includes("private")));
  assert.ok(!result.some((error) => error.includes("plugin.json")), "declaration files must connect owners");
});

test("ownership audit does not authorize private access through a declared dependency", { timeout: 1000 }, () => {
  const errors = auditOwnership([
    "plugins/example/ui/module.js",
    "sidecars/example/src/main.go",
  ], (file) => file.endsWith("module.js")
    ? 'import "@soksak/sidecar-example/src/private.js";\n'
    : "package main\n");
  assert.ok(errors.some((error) => error.includes("private")));
});
