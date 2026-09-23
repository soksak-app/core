import assert from "node:assert/strict";
import test from "node:test";

import { auditVersions, cargoPackageVersion, RELEASE, workspaceManifests } from "../check-versions.mjs";

test("every declared workspace version is the release version", { timeout: 10000 }, () => {
  assert.deepEqual(auditVersions(workspaceManifests()), []);
});

test("version audit rejects a JSON manifest and a Cargo package with another version", { timeout: 1000 }, () => {
  const errors = auditVersions([
    { path: "plugins/a/package.json", text: JSON.stringify({ name: "a", version: "0.0.0" }) },
    { path: "sidecars/b/Cargo.toml", text: '[package]\nname = "b"\nversion = "0.0.0"\n\n[dependencies]\nx = { version = "1" }\n' },
    { path: "package.json", text: JSON.stringify({ name: "workspace", private: true }) },
    { path: "Cargo.toml", text: '[workspace]\nmembers = ["a"]\n' },
    { path: "plugins/c/plugin.json", text: JSON.stringify({ version: RELEASE }) },
  ]);
  assert.deepEqual(errors, [
    `plugins/a/package.json: version "0.0.0" must be ${RELEASE}`,
    `sidecars/b/Cargo.toml: version "0.0.0" must be ${RELEASE}`,
  ]);
});

test("Cargo version reading ignores dependency versions outside [package]", { timeout: 1000 }, () => {
  assert.equal(cargoPackageVersion('[dependencies]\nversion = "9"\n[package]\nversion = "0.0.1"\n'), "0.0.1");
  assert.equal(cargoPackageVersion('[workspace]\nmembers = []\n'), undefined);
});
