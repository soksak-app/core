import assert from "node:assert/strict";
import test from "node:test";

import { auditVersions, cargoPackageVersion, RELEASE, workspaceManifests } from "../check-versions.mjs";

test("every declared workspace version is the release version", { timeout: 10000 }, () => {
  assert.deepEqual(auditVersions(workspaceManifests()), []);
});

test("version audit rejects a JSON manifest, a Cargo package and a Go core version with another version", { timeout: 1000 }, () => {
  const errors = auditVersions([
    { path: "plugins/a/package.json", text: JSON.stringify({ name: "a", version: "0.0.0" }) },
    { path: "sidecars/b/Cargo.toml", text: '[package]\nname = "b"\nversion = "0.0.0"\n\n[dependencies]\nx = { version = "1" }\n' },
    { path: "package.json", text: JSON.stringify({ name: "workspace", private: true }) },
    { path: "Cargo.toml", text: '[workspace]\nmembers = ["a"]\n' },
    { path: "plugins/c/plugin.json", text: JSON.stringify({ version: RELEASE }) },
    { path: "packages/d/src/version.go", text: 'package d\n\nconst CoreVersion = "0.0.0"\n' },
    { path: "packages/e/src/version.go", text: "package e\n" },
  ]);
  assert.deepEqual(errors, [
    `plugins/a/package.json: version "0.0.0" must be ${RELEASE}`,
    `sidecars/b/Cargo.toml: version "0.0.0" must be ${RELEASE}`,
    `packages/d/src/version.go: version "0.0.0" must be ${RELEASE}`,
    "packages/e/src/version.go: const CoreVersion is not declared",
  ]);
});

test("version audit rejects a Go host whose application version is another version", { timeout: 1000 }, () => {
  assert.deepEqual(auditVersions([
    { path: "packages/host/a/src/host.go", text: 'package a\n\nvar (\n\tapplicationVersion = "0.0.0"\n)\n' },
    { path: "packages/host/b/src/host.go", text: `package b\n\nvar applicationVersion = "${RELEASE}"\n` },
  ]), [`packages/host/a/src/host.go: version "0.0.0" must be ${RELEASE}`]);
});

test("Cargo version reading ignores dependency versions outside [package]", { timeout: 1000 }, () => {
  assert.equal(cargoPackageVersion('[dependencies]\nversion = "9"\n[package]\nversion = "0.0.1"\n'), "0.0.1");
  assert.equal(cargoPackageVersion('[workspace]\nmembers = []\n'), undefined);
});

test("version audit rejects an application bundle and a pkg-config Makefile with another version", { timeout: 1000 }, () => {
  const plist = (short, build) => `<plist version="1.0">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${short}</string>\n\t<key>CFBundleVersion</key>\n\t<string>${build}</string>\n</dict>\n</plist>\n`;
  assert.deepEqual(auditVersions([
    { path: "apps/a/platform/darwin/Info.plist", text: plist("0.0.0", RELEASE) },
    { path: "apps/b/platform/darwin/Info.plist", text: plist(RELEASE, "0.0.0") },
    { path: "apps/c/platform/darwin/Info.plist", text: plist(RELEASE, RELEASE) },
    { path: "native/darwin/Makefile", text: "\t  'Name: soksak-darwin' \\\n\t  'Version: 0.0.0' \\\n" },
    { path: "Makefile", text: "build:\n\techo\n" },
  ]), [
    `apps/a/platform/darwin/Info.plist: CFBundleShortVersionString "0.0.0" must be ${RELEASE}`,
    `apps/b/platform/darwin/Info.plist: CFBundleVersion "0.0.0" must be ${RELEASE}`,
    `native/darwin/Makefile: version "0.0.0" must be ${RELEASE}`,
  ]);
  assert.deepEqual(auditVersions([{ path: "apps/d/Info.plist", text: "<plist><dict></dict></plist>" }]),
    ["apps/d/Info.plist: CFBundleShortVersionString is not declared", "apps/d/Info.plist: CFBundleVersion is not declared"]);
});
