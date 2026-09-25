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

test("the surface module is published", () => {
  const source = readFileSync(new URL(`../${manifest.surface.module}`, import.meta.url), "utf8");
  const kinds = { status: "status", commands: "command", dom: "dom" };
  const declared = Object.entries(manifest.exposes ?? {})
    .flatMap(([key, entries]) => entries.map((entry) => `${kinds[key]} ${entry.name}`)).sort();
  const registered = [...source.matchAll(/context\.exposure\.(status|command|dom)\("([^"]+)"/g)]
    .map(([, kind, name]) => `${kind} ${name}`).sort();
  assert.match(source, /export (?:async )?function mount/);
  assert.deepEqual(registered, declared);
});

test("the shell exposes its output, screen, directory, commands, and controls", () => {
  const names = (kind) => manifest.exposes[kind].map((entry) => entry.name).sort();
  assert.deepEqual(names("status"), ["shell.cwd", "shell.history", "shell.jobs", "shell.output", "shell.runs", "shell.screen"]);
  assert.deepEqual(names("commands"), ["shell.clear", "shell.interrupt", "shell.run", "shell.write"]);
  assert.deepEqual(names("dom"), ["shell.clear", "shell.input", "shell.interrupt", "shell.output"]);
});

test("a command that waits for a shell command declares a longer timeout", () => {
  const run = manifest.exposes.commands.find((entry) => entry.name === "shell.run");
  assert.equal(run.timeout, 600000);
});

test("every declared control is represented by the surface module", () => {
  const source = readFileSync(new URL(`../${manifest.surface.module}`, import.meta.url), "utf8");
  const commands = new Set(manifest.exposes.commands.map((entry) => entry.name));
  const dom = new Set(manifest.exposes.dom.map((entry) => entry.name));
  for (const [, command] of source.matchAll(/data-command="([^"]+)"/g)) assert.ok(commands.has(command), command);
  for (const [, name] of source.matchAll(/data-expose="([^"]+)"/g)) assert.ok(dom.has(name), name);
  for (const [control] of source.matchAll(/<(button|input)\b[^>]*>/g)) {
    assert.match(control, /data-expose="[^"]+"/, `${control} has no data-expose`);
  }
});

test("every section module is published and draws a list that dispose removes", async () => {
  // 섹션 모듈이 쓰는 문서 기능만 흉내 낸다.
  const element = () => ({ children: [], textContent: "", className: "", parent: null,
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } });
  globalThis.document = { createElement: element };
  for (const section of manifest.sections ?? []) {
    assert.ok(existsSync(new URL(`../${section.module}`, import.meta.url)), section.module);
    assert.ok(pkg.files.some((entry) => section.module === entry || section.module.startsWith(`${entry}/`)), section.module);
    const root = element();
    const { dispose } = (await import(`../${section.module}`)).mount(root, { card: "c1", surface: "t1" });
    assert.deepEqual(root.children[0].children.map((item) => item.textContent),
      [`${section.name}: 내용 준비 중`, "카드: c1", "탭: t1"], section.id);
    dispose();
    assert.equal(root.children.length, 0, section.id);
  }
  delete globalThis.document;
});
