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

async function mountSection(id, orientation = "vertical") {
  const section = manifest.sections.find((item) => item.id === id);
  // 섹션이 문서에 더하는 stylesheet 를 기록한다.
  globalThis.CSSStyleSheet = class { replaceSync(text) { this.text = text; } };
  globalThis.document = { createElement: element, adoptedStyleSheets: [] };
  const root = element("div");
  const observers = new Map();
  const bound = [];
  const context = { card: null, surface: null, orientation,
    status(name, fn) { observers.set(name, fn); return () => observers.delete(name); },
    bind(el, name, params) { bound.push({ el, name, params }); return el; } };
  const mounted = await (await import(`../${typeof section.module === "string" ? section.module : section.module[orientation]}`)).mount(root, context);
  const send = (name, value, source = "state") => { bound.length = 0; observers.get(name)(value, source); };
  const sheets = () => globalThis.document.adoptedStyleSheets;
  return { root, observers, bound, send, sheets, dispose: () => { mounted.dispose(); delete globalThis.document; delete globalThis.CSSStyleSheet; } };
}

test("every section and the state module are published", () => {
  for (const module of [...manifest.sections.flatMap((section) => typeof section.module === "string" ? [section.module] : Object.values(section.module)), manifest.state.module]) {
    assert.ok(existsSync(new URL(`../${module}`, import.meta.url)), module);
    assert.ok(pkg.files.some((entry) => module === entry || module.startsWith(`${entry}/`)), module);
  }
});

test("the file tree section imports only its package's files and the bundled tree library", () => {
  const source = readFileSync(new URL("../ui/sections/tree.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["../vendor/trees.js", "./tree-paths.js"]);
});

test("the bookmarks section lists files.bookmarks with remove controls", async () => {
  const s = await mountSection("files.bookmarks");
  s.send("files.bookmarks", []);
  assert.equal(s.root.textContent, "북마크 없음");
  s.send("files.bookmarks", ["a.txt"]);
  assert.equal(s.root.textContent, "a.txt삭제");
  assert.deepEqual(s.bound.map(({ name, params }) => [name, params]), [["files.bookmarks.remove", { path: "a.txt" }]]);
  // 경로와 삭제 단추는 각자의 class 로 행 안에 떨어져 놓인다.
  const row = s.root.children[0].children[0];
  assert.deepEqual([row.className, ...row.children.map((child) => child.className)],
    ["files-bookmarks__row", "files-bookmarks__path", "files-bookmarks__remove"]);
  assert.equal(s.sheets().length, 1, "the bookmarks section did not install its style");
  const document = globalThis.document;
  s.dispose();
  assert.equal(document.adoptedStyleSheets.length, 0, "the bookmarks section left its style after dispose");
  assert.equal(s.observers.size, 0);
});

test('file sections declare separate horizontal and vertical implementations',()=>{
 for(const id of ['files.tree','files.bookmarks']) {
  const section=manifest.sections.find(item=>item.id===id);
  assert.equal(typeof section.module,'object',`${id} needs two implementations`);
  assert.notEqual(section.module.horizontal,section.module.vertical);
 }
});

test('horizontal file output exposes every path and directory/select commands and cleans up',async()=>{
 const s=await mountSection('files.tree','horizontal');
 try {
  s.send('files.tree',{root:'/project',error:null,entries:[{path:'src',name:'src',directory:true,expanded:false,depth:0},{path:'readme.md',name:'readme.md',directory:false,expanded:false,depth:0}]});
  assert.ok(s.root.textContent.includes('src'));
  assert.ok(s.root.textContent.includes('readme.md'));
  assert.ok(s.bound.some(item=>item.name==='files.tree.toggle'&&item.params.path==='src'));
  assert.ok(s.bound.some(item=>item.name==='files.select'&&item.params.path==='readme.md'));
  s.send('files.tree',{root:'/project',error:'listing failed',entries:[]});
  assert.ok(s.root.textContent.includes('listing failed'));
 } finally {s.dispose();}
 assert.equal(s.observers.size,0);
});

test('horizontal bookmarks retain all paths and declared removal commands',async()=>{
 const s=await mountSection('files.bookmarks','horizontal');
 try {
  s.send('files.bookmarks',['a.txt','b.txt']);
  assert.ok(s.root.textContent.includes('a.txt'));assert.ok(s.root.textContent.includes('b.txt'));
  assert.deepEqual(s.bound.map(({name,params})=>[name,params]),[['files.bookmarks.remove',{path:'a.txt'}],['files.bookmarks.remove',{path:'b.txt'}]]);
  s.send('files.bookmarks',[]);assert.equal(s.root.textContent,'북마크 없음');
 } finally {s.dispose();}
 assert.equal(s.observers.size,0);
});

test('the horizontal project label stays compact and preserves its full path as a title',async()=>{
 const s=await mountSection('files.tree','horizontal');
 try {
  s.send('files.tree',{root:'/a/long/project/path/project',error:null,entries:[]});
  const header=s.root.children[0].children[0];
  assert.equal(header.children[0].textContent,'project');
  assert.equal(header.children[0].title,'/a/long/project/path/project');
 } finally {s.dispose();}
});

test('the virtual file tree reserves its toolbar and one visible row',()=>{
 const source=readFileSync(new URL('../ui/sections/tree.js',import.meta.url),'utf8');
 const minimum=selector=>{
  const rule=source.slice(source.indexOf(`${selector}{`)).split('}')[0];
  const match=rule.match(/min-height:(\d+)px/);
  assert.ok(match,`${selector} must declare its minimum visible height`);
  return Number(match[1]);
 };
 assert.ok(minimum('.files-tree')>=48,'tree must retain its toolbar plus a row');
 assert.ok(minimum('.files-tree__holder')>=20,'virtual list must retain one visible row');
});
