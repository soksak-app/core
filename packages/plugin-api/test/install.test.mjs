import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALL_FORMAT, PLATFORMS, checkPackageManifest, compareVersions, parseRange, pluginArchiveName, pluginInstallPath,
  resolveInstall, satisfies, sidecarAssetName, sidecarInstallPath, validateInstalled, validatePluginPackage,
  validateRegistryIndex, validateRegistryPack, validateRegistryPlugin, validateRegistrySidecar,
} from "../install.js";

const SHA = "a".repeat(64);
const archive = (name) => ({ url: `file:///releases/${name}`, sha256: SHA });

const plugin = () => ({
  id: "probe", package: "@scope/plugin-probe", name: "Probe", description: "검사용 plugin.", license: "MIT",
  repository: "https://example.invalid/probe",
  versions: [
    { version: "0.1.0", package: archive("probe-0.1.0.tgz"), engines: { soksak: "^0.0.1" }, sidecars: { "@scope/sidecar-worker": "^0.1.0" } },
    { version: "0.2.0", package: archive("probe-0.2.0.tgz"), engines: { soksak: "^0.0.2" }, sidecars: { "@scope/sidecar-worker": "^0.1.0" } },
    { version: "0.3.0", package: archive("probe-0.3.0.tgz"), engines: { soksak: "^0.0.2" }, sidecars: { "@scope/sidecar-worker": "^0.1.0" } },
  ],
});
const sidecar = () => ({
  name: "@scope/sidecar-worker", repository: "https://example.invalid/worker",
  versions: [
    { version: "0.1.0", protocol: 1, assets: { "darwin-arm64": archive("a"), "darwin-x64": archive("b") } },
    { version: "0.1.1", protocol: 1, assets: { "darwin-arm64": archive("c") } },
  ],
});
const index = () => ({
  format: INSTALL_FORMAT, plugins: [plugin()], sidecars: [sidecar()],
  packs: [{ name: "starter", description: "처음 설치하는 plugin.", plugins: ["probe"] }],
  revoked: { plugins: [{ id: "probe", version: "0.3.0", reason: "breaks saved spaces" }], sidecars: [] },
});

test("version ranges accept exact, caret, tilde and bounded forms", () => {
  assert.deepEqual(parseRange("0.0.2"), { min: "0.0.2", below: "0.0.3" });
  assert.deepEqual(parseRange("^0.0.2"), { min: "0.0.2", below: "0.0.3" });
  assert.deepEqual(parseRange("^0.2.3"), { min: "0.2.3", below: "0.3.0" });
  assert.deepEqual(parseRange("^1.2.3"), { min: "1.2.3", below: "2.0.0" });
  assert.deepEqual(parseRange("~1.2.3"), { min: "1.2.3", below: "1.3.0" });
  assert.deepEqual(parseRange(">=0.0.2 <0.1.0"), { min: "0.0.2", below: "0.1.0" });
  assert.equal(satisfies("0.0.9", ">=0.0.2 <0.1.0"), true);
  assert.equal(satisfies("0.1.0", ">=0.0.2 <0.1.0"), false);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0, "versions compare by number, not text");
  for (const bad of ["*", "latest", "0.0", "01.0.0", ">=0.1.0 <0.1.0", "^0.0.2-beta"]) {
    assert.throws(() => parseRange(bad), /invalid version/, bad);
  }
});

test("a plugin package declares its version, core range, sidecar ranges and files", () => {
  const pkg = { name: "@scope/plugin-probe", version: "0.2.0", engines: { soksak: "^0.0.2" },
    soksak: { sidecars: { "@scope/sidecar-worker": "^0.1.0" } }, files: ["plugin.json", "ui"], private: true };
  assert.equal(validatePluginPackage(pkg), pkg);
  checkPackageManifest(pkg, { sidecars: ["@scope/sidecar-worker"] });
  assert.throws(() => checkPackageManifest(pkg, {}), /differ from package.json soksak.sidecars/);
  assert.throws(() => validatePluginPackage({ ...pkg, engines: {} }), /engines.soksak: invalid version range/);
  assert.throws(() => validatePluginPackage({ ...pkg, files: ["ui"] }), /plugin.json is not listed/);
  assert.throws(() => validatePluginPackage({ ...pkg, files: ["plugin.json", "../ui"] }), /paths inside the package/);
  assert.throws(() => validatePluginPackage({ ...pkg, soksak: { sidecars: {}, extra: 1 } }), /unknown field extra/);
});

test("registry entries reject unknown fields, bad archives and repeated versions", () => {
  assert.ok(validateRegistryPlugin(plugin()));
  assert.ok(validateRegistrySidecar(sidecar()));
  assert.ok(validateRegistryPack(index().packs[0]));
  assert.throws(() => validateRegistryPlugin({ ...plugin(), homepage: "x" }), /unknown field homepage/);
  const http = plugin();
  http.versions[0].package.url = "http://example.invalid/probe.tgz";
  assert.throws(() => validateRegistryPlugin(http), /url must be file: or https:/);
  const hash = plugin();
  hash.versions[0].package.sha256 = "ABC";
  assert.throws(() => validateRegistryPlugin(hash), /sha256 must be 64 lowercase hexadecimal digits/);
  const twice = plugin();
  twice.versions.push(twice.versions[0]);
  assert.throws(() => validateRegistryPlugin(twice), /version 0.1.0 appears twice/);
  const platform = sidecar();
  platform.versions[0].assets["darwin-ppc"] = archive("x");
  assert.throws(() => validateRegistrySidecar(platform), /unknown platform darwin-ppc/);
  assert.throws(() => validateRegistryPack({ name: "starter", description: "x", plugins: [] }), /plugins must be plugin ids/);
});

test("the registry index checks names, packs, sidecar ranges and revoked versions across entries", () => {
  assert.ok(validateRegistryIndex(index()));
  const pack = index();
  pack.packs[0].plugins.push("missing");
  assert.throws(() => validateRegistryIndex(pack), /pack starter names unknown plugin missing/);
  const range = index();
  range.plugins[0].versions[0].sidecars["@scope/sidecar-worker"] = "^0.2.0";
  assert.throws(() => validateRegistryIndex(range), /needs @scope\/sidecar-worker \^0.2.0, which no version satisfies/);
  const unknown = index();
  unknown.plugins[0].versions[0].sidecars = { "@scope/sidecar-gone": "^0.1.0" };
  assert.throws(() => validateRegistryIndex(unknown), /needs unknown sidecar @scope\/sidecar-gone/);
  const revoked = index();
  revoked.revoked.plugins[0].version = "9.9.9";
  assert.throws(() => validateRegistryIndex(revoked), /revoked plugin probe 9.9.9 is not listed/);
  const duplicate = index();
  duplicate.plugins.push({ ...plugin(), id: "other" });
  assert.throws(() => validateRegistryIndex(duplicate), /package @scope\/plugin-probe appears twice/);
  assert.throws(() => validateRegistryIndex({ ...index(), format: 2 }), /format must be 1/);
});

test("installation resolves the newest usable plugin and sidecar versions for the core and platform", () => {
  const registry = validateRegistryIndex(index());
  // 0.3.0 은 revoked 이므로 0.2.0 을 고르고, sidecar 는 darwin-arm64 asset 이 있는 가장 새 0.1.1 을 고른다.
  const arm = resolveInstall(registry, "probe", "0.0.2", "darwin-arm64");
  assert.equal(arm.version.version, "0.2.0");
  assert.deepEqual(arm.sidecars.map(({ name, version }) => [name, version]), [["@scope/sidecar-worker", "0.1.1"]]);
  // darwin-x64 asset 은 0.1.0 에만 있다.
  assert.deepEqual(resolveInstall(registry, "probe", "0.0.2", "darwin-x64").sidecars.map(({ version }) => version), ["0.1.0"]);
  assert.equal(resolveInstall(registry, "probe", "0.0.1", "darwin-arm64").version.version, "0.1.0");
  assert.throws(() => resolveInstall(registry, "probe", "0.1.0", "darwin-arm64"), /plugin probe has no version for core 0.1.0/);
  assert.throws(() => resolveInstall(registry, "probe", "0.0.2", "linux-x64"), /has no version for linux-x64/);
  assert.throws(() => resolveInstall(registry, "gone", "0.0.2", "darwin-arm64"), /plugin gone is not in the registry/);
});

test("installation keeps one sidecar version that satisfies every installed plugin", () => {
  const registry = validateRegistryIndex(index());
  const other = (range, version) => ({ format: 1,
    plugins: { other: { package: "plugin-other", version: "1.0.0", enabled: true, sidecars: { "@scope/sidecar-worker": range } } },
    sidecars: { "@scope/sidecar-worker": version } });
  // 다른 plugin 이 0.1.0 을 쓰고 있고 그 version 이 두 범위를 채우므로 더 새 0.1.1 대신 0.1.0 을 그대로 둔다.
  assert.deepEqual(resolveInstall(registry, "probe", "0.0.2", "darwin-arm64", other("^0.1.0", "0.1.0")).sidecars.map(({ version }) => version), ["0.1.0"]);
  // 다른 plugin 의 범위가 0.1.0 만 허용하면 쓰던 version 이 없어도 두 범위를 채우는 0.1.0 을 고른다.
  assert.deepEqual(resolveInstall(registry, "probe", "0.0.2", "darwin-arm64", other("0.1.0", "0.1.0")).sidecars.map(({ version }) => version), ["0.1.0"]);
  // 범위를 함께 채우는 version 이 없으면 각 plugin 과 범위를 밝혀 실패한다.
  assert.throws(() => resolveInstall(registry, "probe", "0.0.2", "darwin-arm64", other("^0.2.0", "0.2.0")),
    /sidecar @scope\/sidecar-worker has no version for darwin-arm64 that satisfies every installed plugin: probe 0.2.0 needs \^0.1.0, other 1.0.0 needs \^0.2.0/);
  // 같은 plugin 의 이전 version 범위는 새 version 을 막지 않는다.
  const self = { format: 1, plugins: { probe: { package: "@scope/plugin-probe", version: "0.1.0", enabled: true, sidecars: { "@scope/sidecar-worker": "0.1.0" } } },
    sidecars: { "@scope/sidecar-worker": "0.1.0" } };
  assert.deepEqual(resolveInstall(registry, "probe", "0.0.2", "darwin-arm64", self).sidecars.map(({ version }) => version), ["0.1.0"]);
});

test("archives and installation paths follow the declared names", () => {
  assert.equal(pluginArchiveName("probe", "0.2.0"), "probe-0.2.0.tgz");
  assert.equal(sidecarAssetName("@scope/sidecar-worker", "0.1.1", "darwin-arm64"), "scope-sidecar-worker-0.1.1-darwin-arm64.tar.gz");
  assert.equal(pluginInstallPath("probe", "0.2.0"), "plugins/probe/0.2.0");
  assert.equal(sidecarInstallPath("@scope/sidecar-worker", "0.1.1", "darwin-arm64"), "sidecars/scope-sidecar-worker/0.1.1/darwin-arm64");
  assert.throws(() => sidecarAssetName("@scope/sidecar-worker", "0.1.1", "solaris-sparc"), /unknown platform/);
  assert.throws(() => pluginInstallPath("../x", "0.2.0"), /invalid plugin id/);
  assert.ok(PLATFORMS.every((platform) => /^(darwin|linux|windows)-(arm64|x64)$/.test(platform)));
});

test("the installed state names one version of each plugin and sidecar and rejects inconsistent entries", () => {
  const installed = { format: 1, plugins: {
    probe: { package: "@scope/plugin-probe", version: "0.2.0", enabled: true, previous: "0.1.0", sidecars: { "@scope/sidecar-worker": "^0.1.0" } },
    side: { package: "plugin-side", version: "1.0.0", enabled: false, sidecars: {} },
  }, sidecars: { "@scope/sidecar-worker": "0.1.1" } };
  assert.equal(validateInstalled(installed), installed);
  const changed = (change) => { const copy = structuredClone(installed); change(copy); return copy; };
  assert.throws(() => validateInstalled(changed((copy) => { delete copy.plugins.probe.enabled; })), /enabled must be true or false/);
  assert.throws(() => validateInstalled(changed((copy) => { copy.plugins.side.package = "@scope/plugin-probe"; })),
    /package @scope\/plugin-probe is installed twice/);
  assert.throws(() => validateInstalled(changed((copy) => { delete copy.sidecars; })), /installed.json sidecars: expected an object/);
  assert.throws(() => validateInstalled(changed((copy) => { delete copy.plugins.side.sidecars; })), /side sidecars: expected an object/);
  assert.throws(() => validateInstalled(changed((copy) => { copy.sidecars = {}; })), /probe: sidecar @scope\/sidecar-worker has no version in use/);
  assert.throws(() => validateInstalled(changed((copy) => { copy.sidecars["@scope/sidecar-worker"] = "0.2.0"; })),
    /probe: sidecar @scope\/sidecar-worker 0.2.0 does not satisfy \^0.1.0/);
  assert.throws(() => validateInstalled(changed((copy) => { copy.sidecars.unused = "1.0.0"; })), /sidecar unused is named by no installed plugin/);
});
