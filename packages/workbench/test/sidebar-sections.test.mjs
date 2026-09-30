// 섹션 모듈이 받는 문맥(status 관찰과 명령 연결)과 core.sidebars 의 섹션 내용을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// 페이지 오류 보고를 기록한다.
const reported = [];
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };

const { registry } = await import("../exposure.js");
const { audit } = await import("../commands.js");
const { registerSection } = await import("../registry.js");
const { drawSet, sidebarsState, clearSet } = await import("../sidebar-sections.js");

registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
registry.declare("probe", {
  status: [{ name: "probe.lines", description: "Lines.", schema: { type: "array" } }],
  commands: [{ name: "probe.send", description: "Sends.", params: { type: "object" }, result: {} }],
  dom: [],
});

// 섹션 모듈: 관찰한 값과 표면을 한 줄로 그리고, 명령에 연결한 단추 하나를 둔다.
const source = `export function mount(root, context) {
  const line = document.createElement("p");
  const button = document.createElement("button");
  button.textContent = "send";
  context.bind(button, "probe.send", { text: "x" });
  const stop = context.status("probe.lines", (value, surface) => { line.textContent = JSON.stringify([surface, value]); });
  root.append(line, button);
  return { dispose() { stop(); line.remove(); button.remove(); } };
}`;
registerSection({ id: "probe.view", name: "보기", module: `data:text/javascript,${encodeURIComponent(source)}` });
// 코어 status 를 따라가고 코어 명령에 연결하는 섹션과 다른 플러그인의 이름을 쓰는 섹션.
const coreSource = `export function mount(root, context) {
  const line = document.createElement("p");
  const button = document.createElement("button");
  button.textContent = "select";
  context.bind(button, "core.tab.select", { tab: "tab-a" });
  const stop = context.status("core.drop", (value, source) => { line.textContent = source + ":" + value.mode; });
  root.append(line, button);
  return { dispose() { stop(); line.remove(); button.remove(); } };
}`;
registerSection({ id: "probe.core", name: "코어", module: `data:text/javascript,${encodeURIComponent(coreSource)}` });
const otherSource = `export function mount(root, context) { context.status("other.cwd", () => {}); return { dispose() {} }; }`;
registerSection({ id: "probe.other", name: "다른", module: `data:text/javascript,${encodeURIComponent(otherSource)}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a section observes its plugin status, binds controls with the section control name, and reports its text", async () => {
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  drawSet(container, "rail-probe", { id: "set-probe", title: "세트", layout: "list", sections: ["probe.view"] },
    { card: "rail-probe", surface: "tab-a", orientation: "vertical" });
  await settle();
  const [state] = sidebarsState();
  assert.equal(state.sections[0].mounted, true, state.sections[0].error);
  assert.equal(state.sections[0].text, "[null,null]send", "without a registered surface the section shows null");
  assert.equal(state.sections[0].controls, 1, "the section reports its controls");
  const button = container.querySelector("button:not(.set__head)");
  assert.equal(button.dataset.expose, "core.sidebar.section.control");
  assert.equal(button.dataset.command, "probe.send");
  assert.equal(button.closest("[data-surface]")?.dataset.surface, "tab-a", "the section names the card's tab");
  assert.deepEqual(audit(container), [], "section controls are connected and named");
  clearSet(container);
});

test("a section follows a core status and binds a core command but not another plugin's names", async () => {
  let theme = { mode: "light" };
  const listeners = new Set();
  registry.status("core.drop", () => theme, (fn) => { listeners.add(fn); return () => listeners.delete(fn); });
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  drawSet(container, "rail-core", { id: "set-core", title: "세트", layout: "list", sections: ["probe.core", "probe.other"] },
    { card: "rail-core", surface: "tab-a", orientation: "vertical" });
  await settle();
  const state = sidebarsState().find((item) => item.sidebar === "rail-core");
  assert.equal(state.sections[0].text, "core:lightselect", state.sections[0].error);
  theme = { mode: "dark" };
  for (const fn of listeners) fn(theme);
  await settle();
  assert.equal(sidebarsState().find((item) => item.sidebar === "rail-core").sections[0].text, "core:darkselect");
  assert.equal(container.querySelector("[data-command='core.tab.select']").dataset.expose, "core.sidebar.section.control");
  assert.match(state.sections[1].error ?? "", /cannot use other.cwd/);
  clearSet(container);
  assert.equal(listeners.size, 0, "clearing the set stops following the core status");
  await settle();
  assert.ok(reported.some((message) => /probe.other: .*cannot use other.cwd/.test(message)), JSON.stringify(reported));
});

test("a section context offers the core icons as the surface context does", async () => {
  const iconSource = `export function mount(root, context) {
    root.innerHTML = context.icon("rotate-cw");
    return { dispose() { root.replaceChildren(); } };
  }`;
  registerSection({ id: "probe.icon", name: "아이콘", module: `data:text/javascript,${encodeURIComponent(iconSource)}` });
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  drawSet(container, "rail-probe-icon", { id: "set-icon", title: "세트", layout: "list", sections: ["probe.icon"] },
    { card: "rail-probe-icon", surface: null, orientation: "vertical" });
  await settle();
  const state = sidebarsState().find((item) => item.sidebar === "rail-probe-icon");
  assert.equal(state.sections[0].error, null);
  assert.match(container.querySelector(".set__body").innerHTML, /<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9/, "the section drew the core icon");
  clearSet(container);
});

test('orientation selects separate implementations and disposes the previous mode while preserving folding', async () => {
  const module = mode => `data:text/javascript,${encodeURIComponent(`export function mount(root,context) {
    root.textContent = '${mode}:'+context.orientation;
    return {dispose(){globalThis.orientationDisposals.push('${mode}');root.replaceChildren();}};
  }`)}`;
  globalThis.orientationDisposals = [];
  registerSection({id:'probe.oriented',name:'Oriented',module:{horizontal:module('horizontal'),vertical:module('vertical')}});
  const container=document.createElement('div');
  container.className='set';document.body.append(container);
  const set={id:'set-oriented',title:'Oriented',layout:'list',sections:['probe.oriented']};
  try {
    drawSet(container,'card:top',set,{card:'card',surface:null,orientation:'horizontal'});
    await settle();
    let state=sidebarsState().find(item=>item.sidebar==='card:top');
    assert.equal(state.sections[0].error,null,'the horizontal implementation must mount');
    assert.equal(state.orientation,'horizontal');
    assert.equal(state.sections[0].text,'horizontal:horizontal');
    const {foldSection}=await import('../sidebar-sections.js');
    foldSection('card:top','probe.oriented');
    drawSet(container,'card:top',set,{card:'card',surface:null,orientation:'vertical'});
    await settle();
    state=sidebarsState().find(item=>item.sidebar==='card:top');
    assert.equal(state.orientation,'vertical');
    assert.equal(state.sections[0].text,'vertical:vertical');
    assert.equal(state.sections[0].folded,true,'orientation change lost the folded choice');
    assert.deepEqual(globalThis.orientationDisposals,['horizontal']);
    clearSet(container);await settle();
    assert.deepEqual(globalThis.orientationDisposals,['horizontal','vertical']);
  } finally {clearSet(container);container.remove();delete globalThis.orientationDisposals;}
});

test('a shared section implementation receives its layout orientation',async()=>{
  const source=`export function mount(root,context){root.textContent=context.orientation;return {dispose(){root.replaceChildren();}};}`;
  registerSection({id:'probe.shared-mode',name:'Shared',module:`data:text/javascript,${encodeURIComponent(source)}`});
  const container=document.createElement('div');container.className='set';document.body.append(container);
  try {
    drawSet(container,'card:bottom',{id:'shared-set',title:'Shared',layout:'list',sections:['probe.shared-mode']},
      {card:'card',surface:null,orientation:'horizontal'});
    await settle();
    assert.equal(sidebarsState().find(item=>item.sidebar==='card:bottom').sections[0].text,'horizontal');
  } finally {clearSet(container);container.remove();}
});

test('section layout rejects an absent or invalid orientation explicitly',()=>{
 const container=document.createElement('div');container.className='set';document.body.append(container);
 const set={id:'shared-set',title:'Shared',layout:'list',sections:['probe.shared-mode']};
 try {
  for(const orientation of [undefined,null,'diagonal']) assert.throws(()=>drawSet(container,'invalid-mode',set,
   {card:'card',surface:null,orientation}),/orientation must be horizontal or vertical/);
 } finally {clearSet(container);container.remove();}
});

test('horizontal list sections use a row while vertical lists use a column',()=>{
 const css=readFileSync(new URL('../app.css',import.meta.url),'utf8');
 const styled=new JSDOM(`<style>${css}</style><div class="set" data-layout="list" data-orientation="horizontal"></div><div class="set" data-layout="list" data-orientation="vertical"></div>`);
 try {
  const [horizontal,vertical]=styled.window.document.querySelectorAll('.set');
  assert.equal(styled.window.getComputedStyle(horizontal).flexDirection,'row');
  assert.equal(styled.window.getComputedStyle(vertical).flexDirection,'column');
 } finally {styled.window.close();}
});

test('a vertical fill section retains its intrinsic header and body minimum when its sidebar is smaller',()=>{
 const css=readFileSync(new URL('../app.css',import.meta.url),'utf8');
 const styled=new JSDOM(`<style>${css}</style><div class="set" data-layout="list" data-orientation="vertical" style="height:48px"><section class="set__section" data-fill="true"><button class="set__head">Tree</button><div class="set__body"><div style="min-height:48px">Files</div></div></section><section class="set__section">Bookmarks</section></div>`);
 try{
  const section=styled.window.document.querySelector('[data-fill]');
  assert.equal(styled.window.getComputedStyle(section).minHeight,'min-content','a fill section must retain its intrinsic minimum');
  assert.equal(styled.window.getComputedStyle(section.querySelector('.set__body')).minHeight,'min-content','the body must retain its intrinsic minimum');
  assert.equal(styled.window.getComputedStyle(section.parentElement).overflow,'auto','the sidebar must scroll instead of dropping section content');
 }finally{styled.window.close();}
});
