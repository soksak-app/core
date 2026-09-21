import assert from "node:assert/strict";
import test from "node:test";
import { auditInventory, discoverInventory, repositoryFiles } from "../check-test-parity.mjs";

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
