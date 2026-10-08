// Checks that the contributions to extension points are resolved from the declarations of installed plugins
// (docs/spec/plugins.md#extension-points).
import assert from "node:assert/strict";
import test from "node:test";
import { manifestSidecars, rangeContains, resolveContributions } from "../index.js";

const provider = {
  id: "probe", package: "@scope/plugin-probe", version: "0.1.0",
  manifest: {
    id: "probe", name: "Probe", description: "검사용 표면.", mark: "p", icon: "<path/>",
    surface: { module: "ui/probe.js", composition: { kind: "dom" } },
    extends: { language: { version: "1.2.0", schema: { type: "object", properties: { extensions: { type: "array", items: { type: "string" } } } } } },
  },
};
const contributor = (id, items, point = "probe.language") => ({
  id, package: `@scope/plugin-${id}`, version: "0.0.1",
  manifest: { id, name: id, description: "검사용 기여.", contributes: { [point]: items } },
});

test("a range contains a version by the installation rules", () => {
  assert.equal(rangeContains("*", "0.0.1"), true);
  assert.equal(rangeContains("^1.0.0", "1.2.0"), true);
  assert.equal(rangeContains("^1.0.0", "2.0.0"), false);
  assert.equal(rangeContains("^0.2.0", "0.3.0"), false);
  assert.equal(rangeContains("^0.0.2", "0.0.3"), false);
  assert.equal(rangeContains("~1.2.0", "1.2.9"), true);
  assert.equal(rangeContains("~1.2.0", "1.3.0"), false);
  assert.equal(rangeContains("1.2.0", "1.2.0"), true);
  assert.equal(rangeContains(">=1.1.0", "9.0.0"), true);
  assert.equal(rangeContains(">=1.1.0", "1.0.9"), false);
  assert.equal(rangeContains(">=1.0.0 <1.2.0", "1.2.0"), false);
  assert.throws(() => rangeContains("latest", "1.0.0"), /invalid range latest/);
});

test("each contributed item is connected, missing its provider, mismatched or invalid", () => {
  const item = { range: "^1.0.0", module: "ui/tidy.js", extensions: ["tidy"] };
  const resolved = resolveContributions([
    provider,
    contributor("tidy", [item, { ...item, range: "^2.0.0" }, { ...item, extensions: "tidy" }]),
    contributor("lost", [item], "absent.language"),
    contributor("other", [item], "probe.format"),
  ]);
  assert.deepEqual(resolved, [
    { plugin: "lost", point: "absent.language", index: 0, state: "provider-missing", reason: "plugin absent is not installed or not enabled" },
    { plugin: "other", point: "probe.format", index: 0, state: "invalid", reason: "probe 0.1.0 declares no extension point format" },
    { plugin: "tidy", point: "probe.language", index: 0, state: "connected", reason: null,
      provider: "probe", item: { extensions: ["tidy"] }, module: "/modules/@scope/plugin-tidy/ui/tidy.js" },
    { plugin: "tidy", point: "probe.language", index: 1, state: "version-mismatch", reason: "range ^2.0.0 does not contain probe.language 1.2.0" },
    { plugin: "tidy", point: "probe.language", index: 2, state: "invalid", reason: "item does not match the schema of probe.language" },
  ]);
});

test("the sidecars of a manifest leave out the packages of installed plugins", () => {
  const manifest = { dependencies: { "@scope/sidecar-files": "^0.0.4", "@scope/plugin-probe": ">=0.1.0" } };
  assert.deepEqual(manifestSidecars(manifest, new Set(["@scope/plugin-probe"])), ["@scope/sidecar-files"]);
  assert.deepEqual(manifestSidecars(manifest), ["@scope/sidecar-files", "@scope/plugin-probe"]);
});
