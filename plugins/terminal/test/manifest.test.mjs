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

test("the terminal exposes its output, screen, directory, commands, and controls", () => {
  const names = (kind) => manifest.exposes[kind].map((entry) => entry.name).sort();
  assert.deepEqual(names("status"), ["terminal.cwd", "terminal.output", "terminal.runs", "terminal.screen"]);
  assert.deepEqual(names("commands"), ["terminal.clear", "terminal.interrupt", "terminal.run", "terminal.write"]);
  assert.deepEqual(names("dom"), ["terminal.clear", "terminal.input", "terminal.interrupt", "terminal.output"]);
});

test("a command that waits for a shell command declares a longer timeout", () => {
  const run = manifest.exposes.commands.find((entry) => entry.name === "terminal.run");
  assert.equal(run.timeout, 600000);
});

test("every control on the page names a declared command and a declared element", () => {
  const html = readFileSync(new URL(`../${manifest.surface.page}`, import.meta.url), "utf8");
  const commands = new Set(manifest.exposes.commands.map((entry) => entry.name));
  const dom = new Set(manifest.exposes.dom.map((entry) => entry.name));
  for (const [, command] of html.matchAll(/data-command="([^"]+)"/g)) assert.ok(commands.has(command), command);
  for (const [, name] of html.matchAll(/data-expose="([^"]+)"/g)) assert.ok(dom.has(name), name);
  for (const [control] of html.matchAll(/<(button|input)\b[^>]*>/g)) {
    assert.match(control, /data-expose="/, `${control} has no data-expose`);
  }
});
