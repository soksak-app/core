// Checks the contributions a provider page receives and that only a failed contribution becomes invalid
// (docs/spec/plugins.md#extension-points).
import assert from "node:assert/strict";
import test from "node:test";
import { contributionsOf, contributionsState, installContributions, onContributionsChange } from "../contributions.js";

const plugin = (id, manifest) => ({ id, package: `@scope/plugin-${id}`, version: "0.1.0",
  manifest: { id, name: id, description: "검사용.", ...manifest } });

test("a provider receives the connected items of its declared points, and a failed item alone becomes invalid", () => {
  installContributions([
    plugin("probe", { mark: "p", icon: "<path/>", surface: { module: "ui/probe.js", composition: { kind: "dom" } },
      extends: { language: { version: "1.0.0", schema: { type: "object" } } } }),
    plugin("one", { contributes: { "probe.language": [{ range: "^1.0.0", module: "ui/one.js", name: "one" }] } }),
    plugin("two", { contributes: { "probe.language": [{ range: "^1.0.0", module: "ui/two.js", name: "two" }] } }),
  ]);
  const items = contributionsOf("probe", "language");
  assert.deepEqual(items.map(({ plugin, item, module }) => ({ plugin, item, module })), [
    { plugin: "one", item: { name: "one" }, module: "/modules/@scope/plugin-one/ui/one.js" },
    { plugin: "two", item: { name: "two" }, module: "/modules/@scope/plugin-two/ui/two.js" },
  ]);
  let changes = 0;
  const off = onContributionsChange(() => { changes += 1; });
  items[0].fail(new Error("extend is not a function"));
  off();
  assert.equal(changes, 1);
  assert.deepEqual(contributionsState(), [
    { plugin: "one", point: "probe.language", index: 0, state: "invalid", reason: "extend failed: extend is not a function" },
    { plugin: "two", point: "probe.language", index: 0, state: "connected", reason: null },
  ]);
  assert.deepEqual(contributionsOf("probe", "language").map((entry) => entry.plugin), ["two"]);
  assert.throws(() => contributionsOf("probe", "format"), /extension point format is not declared by probe/);
  assert.throws(() => contributionsOf("one", "language"), /extension point language is not declared by one/);
});
