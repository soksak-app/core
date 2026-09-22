import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateManifest } from "@soksak/plugin-api";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("plugin.json satisfies the manifest format", () => {
  assert.equal(validateManifest(manifest), manifest);
});

test("the package publishes the manifest and surface module", () => {
  assert.ok(pkg.files.includes("plugin.json"));
  if (manifest.surface?.module === undefined) return;
  assert.ok(existsSync(new URL(`../${manifest.surface.module}`, import.meta.url)), manifest.surface.module);
  assert.ok(pkg.files.some((entry) => manifest.surface.module === entry || manifest.surface.module.startsWith(`${entry}/`)));
});

test("every sidecar the plugin uses is a declared package dependency", () => {
  for (const name of manifest.sidecars ?? []) {
    assert.ok(pkg.dependencies?.[name], `${name} is not a dependency`);
  }
});

test("the surface module delegates terminal startup", () => {
  const source = readFileSync(new URL(`../${manifest.surface.module}`, import.meta.url), "utf8");
  assert.match(source, /startTerminal/);
});

test("registered terminal exposures match manifest declarations", () => {
  const moduleSource = readFileSync(new URL(`../${manifest.surface.module}`, import.meta.url), "utf8");
  const terminalSource = readFileSync(new URL("../ui/terminal.js", import.meta.url), "utf8");
  const source = `${moduleSource}\n${terminalSource}`;
  const kinds = { status: "status", commands: "command", dom: "dom" };
  const declared = Object.entries(manifest.exposes ?? {})
    .flatMap(([kind, entries]) => entries.map((entry) => `${kinds[kind]} ${entry.name}`))
    .sort();
  const registered = [
    ...[...source.matchAll(/expose\.status\(\s*["']([^"']+)["']/g)].map((match) => `status ${match[1]}`),
    ...[...source.matchAll(/expose\.command\(\s*["']([^"']+)["']/g)].map((match) => `command ${match[1]}`),
    ...[...source.matchAll(/expose\.dom\(\s*["']([^"']+)["']/g)].map((match) => `dom ${match[1]}`),
  ].sort();
  assert.deepEqual(registered, declared);
});

test("the terminal exposes its session, input, paste, file drop, screen.read, close commands, and view", () => {
  const names = (kind) => manifest.exposes[kind].map((entry) => entry.name).sort();
  assert.deepEqual(names("status"), ["terminal.compose", "terminal.cursor", "terminal.screen", "terminal.session"]);
  assert.deepEqual(names("commands"), ["terminal.close", "terminal.cursor.set", "terminal.drop", "terminal.focus", "terminal.input", "terminal.paste", "terminal.screen.read"]);
  assert.deepEqual(names("dom"), ["terminal.view"]);
});
