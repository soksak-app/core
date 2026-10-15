import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { checkDeclaration, pluginEntry, repositoryText, sidecarEntry, sidecarReleases } from "../workspace-registry.mjs";

const SHA = "a".repeat(64);

test("registry entries carry the declarations of package.json and the file URL and hash of each release", { timeout: 1000 }, () => {
  const pkg = {
    name: "@scope/plugin-probe", version: "0.0.1", description: "Probe plugin.", license: "MIT",
    repository: { type: "git", url: "git+https://example.invalid/probe.git", directory: "plugins/probe" },
    engines: { soksak: "^0.0.1" },
  };
  const manifest = { id: "probe", name: "검사", dependencies: { "@scope/sidecar-worker": "^0.0.1" } };
  assert.deepEqual(pluginEntry(manifest, pkg, { release: "/releases/a b/probe-0.0.1.tgz", sha256: SHA }, new Set(["@scope/sidecar-worker"])), {
    id: "probe", package: "@scope/plugin-probe", name: "검사", description: "Probe plugin.", license: "MIT",
    repository: "git+https://example.invalid/probe.git",
    versions: [{ version: "0.0.1", release: { url: "file:///releases/a%20b/probe-0.0.1.tgz", sha256: SHA },
      engines: { soksak: "^0.0.1" }, sidecars: { "@scope/sidecar-worker": "^0.0.1" } }],
  });
  assert.deepEqual(pluginEntry({ id: "plain", name: "P" }, pkg, { release: "/r/p.tgz", sha256: SHA }, new Set()).versions[0].sidecars, {});
  // A dependency on a plugin is not a sidecar of the entry; the index lists only sidecar dependencies.
  const contributor = { id: "contributor", name: "C", dependencies: { "@scope/plugin-provider": ">=1.0.0", "@scope/sidecar-worker": "^0.0.1" } };
  assert.deepEqual(pluginEntry(contributor, pkg, { release: "/r/c.tgz", sha256: SHA }, new Set(["@scope/sidecar-worker"])).versions[0].sidecars,
    { "@scope/sidecar-worker": "^0.0.1" });
  assert.deepEqual(sidecarEntry({ name: "@scope/sidecar-worker", version: "0.0.1", repository: "https://example.invalid/w" },
    { executable: "build/worker", protocol: 1 }, { platform: "darwin-arm64", release: "/r/w.tar.gz", sha256: SHA }), {
    name: "@scope/sidecar-worker", repository: "https://example.invalid/w",
    versions: [{ version: "0.0.1", protocol: 1, releases: { "darwin-arm64": { url: "file:///r/w.tar.gz", sha256: SHA } } }],
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

test("the workflows check out every repository that the workspace registry declaration names", { timeout: 1000 }, () => {
  const declaration = JSON.parse(readFileSync(new URL("../workspace-registry.json", import.meta.url), "utf8"));
  const folders = [...declaration.plugins, ...declaration.sidecars.map((sidecar) => sidecar.repository)]
    .map((folder) => folder.replace(/^\.\.\//, ""));
  for (const workflow of ["ci.yml", "window-checks.yml"]) {
    const text = readFileSync(new URL(`../../.github/workflows/${workflow}`, import.meta.url), "utf8");
    const paths = new Set([...text.matchAll(/^\s+path: (\S+)$/gm)].map((match) => match[1]));
    const missing = folders.filter((folder) => !paths.has(folder));
    assert.deepEqual(missing, [], `${workflow} checks out no repository into ${missing.join(", ")}`);
  }
});

test("the registry releases every declared sidecar, also one that no workspace plugin uses", { timeout: 1000 }, () => {
  const declared = ["@scope/sidecar-used", "@scope/sidecar-for-connectors"];
  const manifests = [{ id: "user", dependencies: { "@scope/sidecar-used": "^1.0.0", "@scope/plugin-other": "^1.0.0" } }, { id: "plain" }];
  assert.deepEqual(sidecarReleases(declared, manifests, new Set(["@scope/plugin-other"])), declared);
  assert.throws(() => sidecarReleases(declared, [{ id: "user", dependencies: { "@scope/sidecar-missing": "^1.0.0" } }], new Set()),
    /plugin user uses @scope\/sidecar-missing, which no declared sidecar or plugin folder holds/);
});
