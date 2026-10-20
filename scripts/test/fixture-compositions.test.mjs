// Checks that every tracked plugin manifest of the core repository that declares a surface composition is accepted by the manifest
// reader of plugin-api, which refuses the removed kind dom (docs/spec/plugins.md#surface-composition). The manifests are read from
// the Git index, so an untracked file is not checked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateManifest } from "../../packages/plugin-api/index.js";

const ROOT = new URL("../../", import.meta.url);

const manifests = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((path) => /(^|\/)plugin\.json$/.test(path))
  .map((path) => ({ path, manifest: JSON.parse(readFileSync(new URL(path, ROOT), "utf8")) }))
  .filter(({ manifest }) => manifest.surface?.composition !== undefined);

test("the tracked fixture manifests declare a composition", () => {
  assert.ok(manifests.length > 0, "no tracked plugin manifest declares a surface composition");
});

for (const { path, manifest } of manifests) {
  test(`${path} declares a composition that the manifest reader accepts`, { timeout: 10000 }, () => {
    assert.notEqual(manifest.surface.composition.kind, "dom", `${path} declares the removed kind dom`);
    assert.doesNotThrow(() => validateManifest(manifest));
  });
}
