import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { checkDeclaration, pluginEntry, repositoryText, sidecarEntry } from "../workspace-registry.mjs";

const SHA = "a".repeat(64);

test("registry entries carry the package declarations and the file URL and hash of each archive", { timeout: 1000 }, () => {
  const pkg = {
    name: "@scope/plugin-probe", version: "0.0.1", description: "Probe plugin.", license: "MIT",
    repository: { type: "git", url: "git+https://example.invalid/probe.git", directory: "plugins/probe" },
    engines: { soksak: "^0.0.1" }, soksak: { sidecars: { "@scope/sidecar-worker": "^0.0.1" } },
  };
  assert.deepEqual(pluginEntry({ id: "probe", name: "검사" }, pkg, { archive: "/releases/a b/probe-0.0.1.tgz", sha256: SHA }), {
    id: "probe", package: "@scope/plugin-probe", name: "검사", description: "Probe plugin.", license: "MIT",
    repository: "git+https://example.invalid/probe.git",
    versions: [{ version: "0.0.1", package: { url: "file:///releases/a%20b/probe-0.0.1.tgz", sha256: SHA },
      engines: { soksak: "^0.0.1" }, sidecars: { "@scope/sidecar-worker": "^0.0.1" } }],
  });
  assert.deepEqual(pluginEntry({ id: "plain", name: "P" }, { ...pkg, soksak: undefined }, { archive: "/r/p.tgz", sha256: SHA }).versions[0].sidecars, {});
  assert.deepEqual(sidecarEntry({ name: "@scope/sidecar-worker", version: "0.0.1", repository: "https://example.invalid/w" },
    { executable: "build/worker", protocol: 1 }, { platform: "darwin-arm64", archive: "/r/w.tar.gz", sha256: SHA }), {
    name: "@scope/sidecar-worker", repository: "https://example.invalid/w",
    versions: [{ version: "0.0.1", protocol: 1, assets: { "darwin-arm64": { url: "file:///r/w.tar.gz", sha256: SHA } } }],
  });
  assert.throws(() => repositoryText({ type: "git" }), /package.json repository has no url/);
});

test("the workspace registry declaration names sibling folders and is checked before anything is built", { timeout: 1000 }, () => {
  const declaration = checkDeclaration(JSON.parse(readFileSync(new URL("../workspace-registry.json", import.meta.url), "utf8")));
  assert.ok(declaration.plugins.length > 0);
  const base = { plugins: ["../plugins/a"], sidecars: [{ repository: "../sidecars/a", folder: "." }], packs: [] };
  assert.deepEqual(checkDeclaration(base), base);
  for (const [change, message] of [
    [{ plugins: ["/abs/a"] }, /plugins must be relative folders/],
    [{ plugins: ["../plugins/a", "../plugins/a"] }, /a plugin folder is repeated/],
    [{ sidecars: [{ repository: "../sidecars/a" }] }, /sidecars must be \{ repository, folder \}/],
    [{ packs: {} }, /packs must be a list/],
    [{ extra: 1 }, /expected the keys packs, plugins and sidecars/],
  ]) assert.throws(() => checkDeclaration({ ...base, ...change }), message);
});
