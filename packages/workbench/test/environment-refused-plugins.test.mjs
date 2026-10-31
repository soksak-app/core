// Checks that the page registers the installed plugins that it accepts and returns the error of each plugin that it refuses,
// so one installed plugin does not stop the start (docs/spec/installation.md#serving-installed-plugins).
import assert from "node:assert/strict";
import test from "node:test";

const environmentFile = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
    { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "absent", title: "m" }] },
  ] } },
  sidebars: { sets: [], links: [] },
};
const accepted = { id: "side", package: "@fixture/side", version: "0.0.1",
  manifest: { id: "side", name: "Side", description: "검사용 섹션.", sections: [{ id: "side.list", name: "List", status: "side.list" }], host: { page: "ui/host.html" }, exposes: { status: [{ name: "side.list", description: "검사용 상태.", schema: { type: "object" } }] } } };
const refused = { id: "earlier", package: "@fixture/earlier", version: "0.0.1", manifest: { id: "earlier", description: "이름이 없는 manifest." } };

test("an installed plugin whose manifest is refused is left out with its error and the other plugins are registered", async () => {
  const { installEnvironment, pluginUnits } = await import("../environment.js?test=refused-manifest");
  const registry = await import("../registry.js");
  const errors = installEnvironment(environmentFile, { plugins: [refused, accepted] });
  assert.equal(errors.length, 1, `errors ${JSON.stringify(errors)}`);
  assert.match(errors[0], /^installed plugin earlier 0\.0\.1 \(@fixture\/earlier\): /);
  assert.deepEqual(pluginUnits().map((unit) => unit.id), ["side"]);
  assert.equal(registry.section("side.list").id, "side.list");
});

test("an installed plugins document that carries the error of the host registers no plugin and returns the error", async () => {
  const { installEnvironment, pluginUnits } = await import("../environment.js?test=error-document");
  const errors = installEnvironment(environmentFile, { error: "plugins/installed.json: format must be 3" });
  assert.deepEqual(errors, ["installed plugins: plugins/installed.json: format must be 3"]);
  assert.deepEqual(pluginUnits(), []);
});
