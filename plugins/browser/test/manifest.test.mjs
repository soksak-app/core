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

test("every section module is published", () => {
  for (const section of manifest.sections ?? []) {
    assert.ok(existsSync(new URL(`../${section.module}`, import.meta.url)), section.module);
    assert.ok(pkg.files.some((entry) => section.module === entry || section.module.startsWith(`${entry}/`)), section.module);
  }
});

/** 섹션 모듈이 쓰는 문서 기능만 흉내 낸다. */
const node = (tag) => ({ tag, children: [], attributes: {}, className: "", title: "", parent: null, _text: "",
  style: {},
  get textContent() { return this._text + this.children.map((item) => item.textContent).join(""); },
  set textContent(value) { this._text = value; this.children = []; },
  setAttribute(name, value) { this.attributes[name] = value; },
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); },
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); } });

/** 섹션을 마운트하고, 관찰한 status 에 값을 보내는 함수와 연결한 요소를 돌려준다. */
async function mountSection(id, surface = "t1") {
  const section = manifest.sections.find((item) => item.id === id);
  globalThis.document = { createElement: node };
  const root = node("div");
  const observers = new Map();
  const bound = [];
  const context = { card: "rail", surface,
    status(name, fn) { observers.set(name, fn); return () => observers.delete(name); },
    bind(el, name, params) { bound.push({ el, name, params }); return el; } };
  const mounted = await (await import(`../${section.module}`)).mount(root, context);
  const send = (name, value, source = "t1") => { bound.length = 0; observers.get(name)(value, source); };
  return { root, observers, bound, send, dispose: () => { mounted.dispose(); delete globalThis.document; } };
}

test("the history section lists browser.history and loads an entry on press", async () => {
  const s = await mountSection("browser.history");
  s.send("browser.history", null, null);
  assert.equal(s.root.textContent, "브라우저 표면 없음");
  s.send("browser.history", { entries: [], index: -1 });
  assert.equal(s.root.textContent, "기록 없음");
  s.send("browser.history", { entries: [{ url: "https://a.test/one", title: "One" }, { url: "https://a.test/two", title: "" }], index: 1 });
  assert.deepEqual(s.bound.map(({ el, name, params }) => [el.textContent, el.attributes["aria-current"] ?? null, name, params]),
    [["One", null, "browser.history.go", { index: 0 }], ["https://a.test/two", "page", "browser.history.go", { index: 1 }]]);
  s.dispose();
  assert.equal(s.observers.size, 0);
});

test("the tabs section lists the browser tabs of the card that holds its surface and selects a tab on press", async () => {
  const s = await mountSection("browser.tabs", "b1");
  const grid = { cards: [
    { id: "rail", tabs: [], active: null },
    { id: "main", active: "b1", tabs: [
      { id: "b1", plugin: "browser", title: "브라우저", label: "One" },
      { id: "s1", plugin: "other", title: "다른", label: null },
      { id: "b2", plugin: "browser", title: "브라우저", label: null }] }] };
  s.send("core.grid", grid, "core");
  assert.deepEqual(s.bound.map(({ el, name, params }) => [el.textContent, el.attributes["aria-current"] ?? null, name, params]),
    [["One", "page", "core.tab.select", { tab: "b1" }], ["브라우저", null, "core.tab.select", { tab: "b2" }]]);
  s.send("core.grid", { cards: [] }, "core");
  assert.equal(s.root.textContent, "브라우저 탭 없음");
  s.dispose();
  assert.equal(s.observers.size, 0);
});

test("the DOM section lists browser.elements indented by depth", async () => {
  const s = await mountSection("browser.dom");
  s.send("browser.elements", null, null);
  assert.equal(s.root.textContent, "브라우저 표면 없음");
  s.send("browser.elements", { nodes: [], truncated: false });
  assert.equal(s.root.textContent, "요소 없음");
  s.send("browser.elements", { nodes: [{ depth: 0, tag: "html", id: "", class: "" }, { depth: 1, tag: "div", id: "box", class: " a  b " }], truncated: true });
  const items = s.root.children[0].children;
  assert.deepEqual(items.map((item) => [item.textContent, item.style.paddingLeft ?? null]),
    [["html", "0px"], ["div#box.a.b", "8px"], ["요소가 더 있음", null]]);
  assert.equal(s.bound.length, 0);
  s.dispose();
  assert.equal(s.observers.size, 0);
});

test("the network section lists browser.requests with type, address, and duration", async () => {
  const s = await mountSection("browser.network");
  s.send("browser.requests", { entries: [], truncated: false });
  assert.equal(s.root.textContent, "요청 없음");
  s.send("browser.requests", { entries: [{ url: "https://a.test/", type: "navigation", start: 0, duration: 12.4 },
    { url: "https://a.test/x.png", type: "img", start: 20, duration: 3.6 }], truncated: false });
  assert.deepEqual(s.root.children[0].children.map((item) => item.textContent),
    ["navigation https://a.test/ 12ms", "img https://a.test/x.png 4ms"]);
  s.dispose();
});
