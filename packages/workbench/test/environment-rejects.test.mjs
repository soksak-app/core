import assert from "node:assert/strict";
import test from "node:test";

// An environment.json with a reference that does not match registers nothing and fails.
const environmentFile = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "side", title: "m" }] },
  ] } },
  sidebars: { sets: [], links: [] },
};
const installed = { plugins: [{ id: "side", package: "@fixture/side", version: "0.0.1",
  manifest: { id: "side", name: "Side", description: "검사용 섹션.", sections: [{ id: "side.list", name: "List", module: "ui/list.js" }] } }] };

const { installEnvironment } = await import("../environment.js");
const registry = await import("../registry.js");

// A tab of a plugin that is not loaded opens as a placeholder, so it does not fail (docs/spec/plugins.md). A loaded plugin
// used in a tab without a surface fails.
test("an environment naming a loaded plugin without a surface as a tab fails before registration", () => {
  assert.throws(() => installEnvironment(environmentFile, installed), /tab plugin side has no surface/);
  assert.throws(() => registry.section("side.list"), /unknown section/);
});
