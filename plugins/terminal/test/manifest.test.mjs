import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateDiagnostics, validateManifest } from "@soksak/plugin-api";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const diagnostics = JSON.parse(readFileSync(new URL("../diagnostics.json", import.meta.url), "utf8"));

/** 소스에서 등록한 공개 항목을 `<종류> <이름>` 으로 모은다. */
const registrations = (source) => [
  ...[...source.matchAll(/expose\.status\(\s*["']([^"']+)["']/g)].map((match) => `status ${match[1]}`),
  ...[...source.matchAll(/expose\.command\(\s*["']([^"']+)["']/g)].map((match) => `command ${match[1]}`),
  ...[...source.matchAll(/expose\.dom\(\s*["']([^"']+)["']/g)].map((match) => `dom ${match[1]}`),
].sort();
const kinds = { status: "status", commands: "command", dom: "dom" };
const declarations = (exposes) => Object.entries(exposes ?? {})
  .flatMap(([kind, entries]) => entries.map((entry) => `${kinds[kind]} ${entry.name}`))
  .sort();

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
  assert.deepEqual(registrations(`${moduleSource}\n${terminalSource}`), declarations(manifest.exposes));
});

test("diagnostics.json declares the entries its module registers and is not published", () => {
  assert.equal(validateDiagnostics(manifest, diagnostics), diagnostics);
  const source = readFileSync(new URL(`../${diagnostics.module}`, import.meta.url), "utf8");
  assert.deepEqual(registrations(source), declarations(diagnostics.exposes));
  for (const path of ["diagnostics.json", diagnostics.module]) {
    assert.equal(pkg.files.some((entry) => path === entry || path.startsWith(`${entry}/`)), false, `${path} is published`);
  }
});

test("the diagnostic entries inject preedit and record the IME trace", () => {
  const names = (kind) => diagnostics.exposes[kind].map((entry) => entry.name).sort();
  assert.deepEqual(names("status"), ["terminal.ime.trace", "terminal.pointer.trace"]);
  assert.deepEqual(names("commands"), ["terminal.compose.update", "terminal.ime.trace", "terminal.pointer.trace", "terminal.pty.pending"]);
});

test("the terminal exposes its session, input, preedit, paste, file drop, screen.read, close commands, and view", () => {
  const names = (kind) => manifest.exposes[kind].map((entry) => entry.name).sort();
  assert.deepEqual(names("status"), ["terminal.compose", "terminal.cursor", "terminal.screen", "terminal.session"]);
  assert.deepEqual(names("commands"), ["terminal.close", "terminal.copy", "terminal.cursor.set", "terminal.drop", "terminal.focus", "terminal.image.inline.delete", "terminal.input", "terminal.link.open", "terminal.paste", "terminal.screen.read", "terminal.scrollback.set"]);
  assert.deepEqual(names("dom"), ["terminal.scrollbar", "terminal.scrollbar.thumb", "terminal.view"]);
});
