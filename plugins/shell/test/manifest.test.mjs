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

/** 섹션 모듈이 쓰는 문서 기능만 흉내 낸다. */
const element = (tag) => ({ tag, children: [], dataset: {}, className: "", parent: null, _text: "",
  get textContent() { return this._text + this.children.map((item) => item.textContent).join(""); },
  set textContent(value) { this._text = value; this.children = []; },
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); },
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } });

/** 섹션을 마운트하고, 관찰한 status 에 값을 보내는 함수와 연결한 요소를 돌려준다. */
async function mountSection(id) {
  const section = manifest.sections.find((item) => item.id === id);
  globalThis.document = { createElement: element };
  const root = element("div");
  const observers = new Map();
  const bound = [];
  const context = { card: "c1", surface: "t1",
    status(name, fn) { observers.set(name, fn); return () => observers.delete(name); },
    bind(el, name, params) { bound.push({ el, name, params }); return el; } };
  const mounted = await (await import(`../${section.module}`)).mount(root, context);
  const send = (name, value, surface = "t1") => { bound.length = 0; observers.get(name)(value, surface); };
  return { root, observers, bound, send, dispose: () => { mounted.dispose(); delete globalThis.document; } };
}

test("every section module is published", () => {
  for (const section of manifest.sections ?? []) {
    assert.ok(existsSync(new URL(`../${section.module}`, import.meta.url)), section.module);
    assert.ok(pkg.files.some((entry) => section.module === entry || section.module.startsWith(`${entry}/`)), section.module);
  }
});

test("the cwd section shows shell.cwd", async () => {
  const s = await mountSection("shell.cwd");
  s.send("shell.cwd", null, null);
  assert.equal(s.root.textContent, "셸 표면 없음");
  s.send("shell.cwd", null);
  assert.equal(s.root.textContent, "디렉터리 보고 전");
  s.send("shell.cwd", "/tmp/project");
  assert.equal(s.root.textContent, "/tmp/project");
  s.dispose();
  assert.equal(s.observers.size, 0);
  assert.equal(s.root.children.length, 0);
});

test("the run history section lists shell.history and writes an entry again on press", async () => {
  const s = await mountSection("shell.history");
  s.send("shell.history", []);
  assert.equal(s.root.textContent, "기록 없음");
  s.send("shell.history", ["ls", "pwd"]);
  assert.equal(s.root.textContent, "lspwd");
  assert.deepEqual(s.bound.map(({ el, name, params }) => [el.tag, el.textContent, name, params]),
    [["button", "ls", "shell.write", { data: "ls\n" }], ["button", "pwd", "shell.write", { data: "pwd\n" }]]);
  s.dispose();
  assert.equal(s.observers.size, 0);
});

test("the jobs section lists shell.jobs with an interrupt control", async () => {
  const s = await mountSection("shell.jobs");
  s.send("shell.jobs", []);
  assert.equal(s.root.textContent, "실행 중인 작업 없음");
  assert.equal(s.bound.length, 0);
  s.send("shell.jobs", [{ id: "run-1", command: "sleep 5" }]);
  assert.equal(s.root.textContent, "sleep 5중단");
  assert.deepEqual(s.bound.map(({ name, params }) => [name, params]), [["shell.interrupt", {}]]);
  s.dispose();
  assert.equal(s.observers.size, 0);
});
