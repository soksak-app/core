import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateManifest } from "@soksak/plugin-api";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("plugin.json satisfies the manifest format", () => {
  assert.equal(validateManifest(manifest), manifest);
});

test("the package publishes the manifest and the surface page", () => {
  assert.ok(pkg.files.includes("plugin.json"));
  if (manifest.surface?.page === undefined) return;
  assert.ok(existsSync(new URL(`../${manifest.surface.page}`, import.meta.url)), manifest.surface.page);
  assert.ok(pkg.files.some((entry) => manifest.surface.page === entry || manifest.surface.page.startsWith(`${entry}/`)));
});

test("every sidecar the plugin uses is a declared package dependency", () => {
  for (const name of manifest.sidecars ?? []) {
    assert.ok(pkg.dependencies?.[name], `${name} is not a dependency`);
  }
});

test("the surface page registers every declared exposure", () => {
  const html = readFileSync(new URL(`../${manifest.surface.page}`, import.meta.url), "utf8");
  const kinds = { status: "status", commands: "command", dom: "dom" };
  const declared = Object.entries(manifest.exposes ?? {})
    .flatMap(([key, entries]) => entries.map((entry) => `${kinds[key]} ${entry.name}`)).sort();
  const registered = [...html.matchAll(/expose\.(status|command|dom)\("([^"]+)"/g)]
    .map(([, kind, name]) => `${kind} ${name}`).sort();
  assert.deepEqual(registered, declared);
});

test("the terminal exposes its input, output, and write command", () => {
  const names = Object.values(manifest.exposes).flat().map((entry) => entry.name).sort();
  assert.deepEqual(names, ["terminal.input", "terminal.output", "terminal.output", "terminal.write"].sort());
});
