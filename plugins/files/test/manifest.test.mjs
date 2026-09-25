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

/** 섹션 모듈이 쓰는 문서 기능만 흉내 낸다. */
const element = (tag) => ({ tag, children: [], dataset: {}, className: "", style: {}, parent: null, _text: "",
  get textContent() { return this._text + this.children.map((item) => item.textContent).join(""); },
  set textContent(value) { this._text = value; this.children = []; },
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); },
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } });

async function mountSection(id) {
  const section = manifest.sections.find((item) => item.id === id);
  globalThis.document = { createElement: element };
  const root = element("div");
  const observers = new Map();
  const bound = [];
  const context = { card: null, surface: null,
    status(name, fn) { observers.set(name, fn); return () => observers.delete(name); },
    bind(el, name, params) { bound.push({ el, name, params }); return el; } };
  const mounted = await (await import(`../${section.module}`)).mount(root, context);
  const send = (name, value, source = "state") => { bound.length = 0; observers.get(name)(value, source); };
  return { root, observers, bound, send, dispose: () => { mounted.dispose(); delete globalThis.document; } };
}

test("every section and the state module are published", () => {
  for (const module of [...manifest.sections.map((section) => section.module), manifest.state.module]) {
    assert.ok(existsSync(new URL(`../${module}`, import.meta.url)), module);
    assert.ok(pkg.files.some((entry) => module === entry || module.startsWith(`${entry}/`)), module);
  }
});

test("the file tree section draws files.tree with toggles, bookmark controls, and a refresh control", async () => {
  const s = await mountSection("files.tree");
  s.send("files.tree", null, null);
  assert.equal(s.root.textContent, "프로젝트 없음");
  s.send("files.tree", { root: "/work/p1", error: "denied", entries: [] });
  assert.equal(s.root.textContent, "새로 고침오류: denied");
  s.send("files.tree", { root: "/work/p1", error: null, entries: [
    { path: "src", name: "src", directory: true, depth: 0, expanded: true },
    { path: "src/main.go", name: "main.go", directory: false, depth: 1, expanded: false },
  ] });
  assert.equal(s.root.textContent, "새로 고침▾ srcmain.go☆");
  assert.deepEqual(s.bound.map(({ el, name, params }) => [el.textContent, name, params]), [
    ["새로 고침", "files.refresh", {}],
    ["▾ src", "files.tree.toggle", { path: "src" }],
    ["☆", "files.bookmarks.add", { path: "src/main.go" }],
  ]);
  s.dispose();
  assert.equal(s.observers.size, 0);
  assert.equal(s.root.children.length, 0);
});

test("the bookmarks section lists files.bookmarks with remove controls", async () => {
  const s = await mountSection("files.bookmarks");
  s.send("files.bookmarks", []);
  assert.equal(s.root.textContent, "북마크 없음");
  s.send("files.bookmarks", ["a.txt"]);
  assert.equal(s.root.textContent, "a.txt삭제");
  assert.deepEqual(s.bound.map(({ name, params }) => [name, params]), [["files.bookmarks.remove", { path: "a.txt" }]]);
  s.dispose();
  assert.equal(s.observers.size, 0);
});
