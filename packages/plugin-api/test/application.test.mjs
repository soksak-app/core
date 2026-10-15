import assert from "node:assert/strict";
import test from "node:test";

import { validateManifest } from "../index.js";

/** A connector plugin: no surface of its own, an application, and a dependency on the plugin that shows it. */
const connector = (application) => ({
  id: "sketcher-connector",
  name: "Sketcher",
  description: "Connects an sketcher application that its own distribution installs.",
  dependencies: { "@soksak/plugin-viewer": "^0.0.1" },
  application,
});

const entry = {
  locate: [{ bundle: "org.example.sketcher" }, { command: "sketcher" }, { path: "/Applications/Sketcher.app/Contents/MacOS/sketcher" }],
  recipe: { kind: "release", url: "https://example.org/sketcher-1.0.0-darwin-arm64.zip", sha256: "a".repeat(64), unpack: "zip" },
  program: "Sketcher.app/Contents/MacOS/sketcher",
  arguments: ["--embed"],
};

test("a connector plugin declares an application and needs no surface", () => {
  const manifest = connector({ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": entry } });
  assert.equal(validateManifest(manifest), manifest);
});

test("each recipe kind of the specification is accepted", () => {
  for (const recipe of [
    { kind: "package", manager: "brew", name: "sketcher", cask: true },
    { kind: "source", repository: "https://example.org/sketcher.git", ref: "v1.0.0", commands: [["cargo", "build", "--release"]] },
    { kind: "release", url: "https://example.org/sketcher", sha256: "b".repeat(64), unpack: "none" },
  ]) {
    const manifest = connector({ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-x64": { ...entry, locate: [{ command: "sketcher" }], recipe } } });
    assert.equal(validateManifest(manifest), manifest, recipe.kind);
  }
});

test("an application that breaks the specification is refused with what it found", () => {
  const cases = [
    [{ id: "Sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": entry } }, /application id must be a lowercase identifier/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: {} }, /application platforms must name at least one platform/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-ppc": entry } }, /application platform darwin-ppc is not one of darwin-arm64, darwin-x64, linux-x64, windows-x64/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": { ...entry, locate: [] } } }, /locate must list at least one way/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": { ...entry, locate: [{ registry: "x" }] } } }, /locate entry 0 must be one of bundle, appid, command or path/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": { ...entry, recipe: { kind: "release", url: "http://example.org/a.zip", sha256: "a".repeat(64), unpack: "zip" } } } }, /release url must be an https address/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": { ...entry, recipe: { kind: "release", url: "https://example.org/a.zip", sha256: "short", unpack: "zip" } } } }, /release sha256 must be 64 lowercase hexadecimal digits/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": { ...entry, recipe: { kind: "copy" } } } }, /recipe kind must be release, package or source/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": { ...entry, recipe: { kind: "package", manager: "brew", name: "sketcher" } } } }, /package cask must be true or false/],
    [{ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": { ...entry, program: "/abs/sketcher" } } }, /program must be a path inside the installed folder/],
  ];
  for (const [application, pattern] of cases) {
    assert.throws(() => validateManifest(connector(application)), pattern, JSON.stringify(application).slice(0, 80));
  }
});

test("each platform finds and installs its application in its own way", () => {
  const linux = { locate: [{ appid: "com.example.Sketcher" }, { command: "sketcher" }], recipe: { kind: "package", manager: "flatpak", name: "com.example.Sketcher" }, program: "sketcher" };
  const windows = { locate: [{ appid: "Example.Sketcher" }], recipe: { kind: "package", manager: "winget", name: "Example.Sketcher" }, program: "Sketcher/sketcher.exe" };
  const manifest = connector({ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms: { "darwin-arm64": entry, "linux-x64": linux, "windows-x64": windows } });
  assert.equal(validateManifest(manifest), manifest);
  const refused = [
    [{ "linux-x64": { ...linux, locate: [{ bundle: "com.example.sketcher" }] } }, /locate entry 0 bundle names an application of darwin, not linux-x64/],
    [{ "darwin-arm64": { ...entry, locate: [{ appid: "com.example.sketcher" }] } }, /locate entry 0 appid names an application of windows or linux, not darwin-arm64/],
    [{ "linux-x64": { ...linux, recipe: { kind: "package", manager: "brew", name: "sketcher", cask: false } } }, /package manager of linux-x64 must be flatpak, not brew/],
    [{ "windows-x64": { ...windows, recipe: { kind: "package", manager: "flatpak", name: "x" } } }, /package manager of windows-x64 must be winget, not flatpak/],
    [{ "linux-x64": { ...linux, recipe: { kind: "package", manager: "flatpak", name: "x", cask: true } } }, /package cask belongs to brew/],
  ];
  for (const [platforms, pattern] of refused) {
    assert.throws(() => validateManifest(connector({ id: "sketcher", name: "Sketcher", version: "1.0.0", platforms })), pattern);
  }
});
