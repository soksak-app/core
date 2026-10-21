// Checks the context that a section module receives (status observation and command connection), the drawing of a declared
// section, and the section content of core.sidebars.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Records the page error reports.
const reported = [];
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.dispatchEvent = (event) => { reported.push(event.message); return true; };

// The snapshot channel and the pull of a declared section source are fakes at the transport boundary of the main page
// (declared-source.js), which the tests replace with a fake host.
const declaredWorld = { channel: () => null, pull: () => Promise.resolve({ seq: 0, value: null }) };
mock.module("../declared-source.js", { namedExports: {
  createDeclaredSource: ({ plugin, status }) => ({
    channel: (source) => declaredWorld.channel(source),
    pull: (source) => declaredWorld.pull(source, status),
    plugin, status,
  }),
} });
// Records the lines that the one error display path writes (shown-errors.js reports through host.js).
const logged = [];
mock.module("../host.js", { namedExports: { report: (line) => { logged.push(line); } } });

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

// A section module: it draws the observed value and the surface in one line, and has one button connected to a command.
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
// A section that follows a core status and connects to a core command, and a section that uses the name of another plugin.
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

test('a declared tree in a horizontal body takes a full line of the row',()=>{
 const css=readFileSync(new URL('../app.css',import.meta.url),'utf8');
 const styled=new JSDOM(`<style>${css}</style><div class="set" data-orientation="horizontal"><div class="set__body" data-declared><div class="declared-tree"></div></div></div>`);
 try {
  const tree=styled.window.document.querySelector('.declared-tree');
  assert.equal(styled.window.getComputedStyle(tree).flexBasis,'100%','a tree in a horizontal body must take the width of its line');
 } finally {styled.window.close();}
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

/** Declares one plugin with one status and one command, registers its declared section, and registers the surface that owns the status.
 * The section carries the full status name, as the manifest requires (validateManifest refuses a short name). */
function declareDeclaredPlugin(plugin, surface, section = {}) {
  registry.configure({ surfacePlugin: () => plugin });
  registry.declare(plugin, {
    status: [{ name: `${plugin}.lines`, description: "Lines.", schema: { type: "array" } }],
    commands: [{ name: `${plugin}.open`, description: "Opens.", params: { type: "object" }, result: {} }],
    dom: [],
  });
  registerSection({ id: `${plugin}.view`, name: "선언", status: `${plugin}.lines`, ...section });
  registry.registered({ surface, kind: "status", name: `${plugin}.lines` });
}

/** Subscribes a channel per source and counts the pulls. */
function declaredTransport() {
  const listeners = new Map();
  const requested = [];
  declaredWorld.channel = (source) => ({
    send: () => {},
    onMessage: (listener) => { listeners.set(source.id, listener); return () => listeners.delete(source.id); },
  });
  declaredWorld.pull = (source, status) => { requested.push(status); return Promise.resolve({ seq: 0, value: null }); };
  return { listeners, requested };
}

const pushTo = (listeners, plugin, seq, value) =>
  // The snapshot of a view names the status in its plugin (docs/spec/declared-ui.md).
  listeners.get("view-a")({ event: "declared-ui.snapshot", plugin, status: "lines", seq, value, skipped: 0 });

test("a declared section draws the value of its source, shows its rejection, and reports mounted, error, text and controls", async () => {
  const plugin = "probe-d1";
  declareDeclaredPlugin(plugin, "view-a", { fill: true });
  const { listeners, requested } = declaredTransport();
  const value = { elements: [
    { kind: "list", key: "l1", empty: "없음", items: [{ key: "a", label: "첫" }, { key: "b", label: "둘", command: `${plugin}.open` }] },
  ] };
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  try {
    drawSet(container, "rail-d1", { id: "set-d1", title: "세트", layout: "list", sections: [`${plugin}.view`] },
      { card: "rail-d1", surface: "view-a", orientation: "vertical" });
    await settle();
    const section = container.querySelector(".set__section");
    const body = section.querySelector(".set__body");
    const report = () => sidebarsState().find((item) => item.sidebar === "rail-d1").sections[0];
    assert.equal(section.dataset.fill, "true", "the declared section does not take the fill declaration");
    const header = container.querySelector('[data-expose="core.sidebar.section.header"]');
    assert.notEqual(header, null, "the declared section has no header");
    assert.equal(header.dataset.command, "core.sidebar.section.fold", "the declared section header does not fold");
    assert.ok(listeners.has("view-a"), "the chosen source was not subscribed");
    assert.deepEqual(requested, ["lines"], "the pull did not request the status of the plugin");
    assert.equal(report().mounted, false, "the section is mounted before its first accepted value");
    assert.equal(report().error, null, "the section reports an error without a rejected value");
    assert.equal(report().text, "", "the section drew something before its first accepted value");
    assert.equal(report().controls, 0, "the cleared section reports controls");
    pushTo(listeners, plugin, 1, value);
    assert.equal(report().mounted, true, "the accepted value is not reported as mounted");
    assert.equal(report().error, null, "an accepted value reported an error");
    assert.equal(report().text, "첫둘", "the accepted value was not drawn");
    assert.equal(report().controls, 1, "the section does not report its one control");
    assert.equal(body.querySelector('button[data-key="l1"][data-path]').textContent, "둘", "the item button was not drawn");
    pushTo(listeners, plugin, 2, { elements: [{ kind: "chart", key: "x" }] });
    assert.equal(report().mounted, false, "a rejected value is reported as mounted");
    assert.equal(report().error, '/elements/0/kind: unknown kind "chart"', "the rejection is not reported as the error");
    assert.equal(body.dataset.error, `declared UI ${plugin}.lines`, "the rejection did not come from the display path");
    assert.equal(report().text, '/elements/0/kind: unknown kind "chart"', "the section does not show the text of the display path");
    assert.ok(logged.includes(`declared UI ${plugin}.lines: /elements/0/kind: unknown kind "chart"`), JSON.stringify(logged));
    pushTo(listeners, plugin, 3, value);
    assert.equal(report().mounted, true, "the next accepted value is not reported as mounted");
    assert.equal(report().error, null, "the next accepted value did not clear the reported error");
    assert.equal(body.dataset.error, undefined, "the next accepted value did not withdraw the error display");
  } finally {
    clearSet(container);
    container.remove();
  }
});

test("a declared section whose status the active surface did not register stays cleared and subscribes to nothing", async () => {
  const plugin = "probe-d2";
  declareDeclaredPlugin(plugin, "view-a");
  const { listeners, requested } = declaredTransport();
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  try {
    drawSet(container, "rail-d2", { id: "set-d2", title: "세트", layout: "list", sections: [`${plugin}.view`] },
      { card: "rail-d2", surface: "view-b", orientation: "vertical" });
    await settle();
    const report = () => sidebarsState().find((item) => item.sidebar === "rail-d2").sections[0];
    assert.equal(listeners.size, 0, "a channel was subscribed without a chosen source");
    assert.equal(requested.length, 0, "a value was pulled without a chosen source");
    assert.equal(report().mounted, false, "the section is mounted without a chosen source");
    assert.equal(report().error, null, "the section reports an error without a chosen source");
    assert.equal(report().text, "", "the section drew something without a chosen source");
  } finally {
    clearSet(container);
    container.remove();
  }
});

test("an orientation change keeps the accepted declared tree and makes no pull", async () => {
  const plugin = "probe-d3";
  declareDeclaredPlugin(plugin, "view-a");
  const listeners = new Map();
  let pulls = 0;
  declaredWorld.channel = (source) => ({
    send: () => {},
    onMessage: (listener) => { listeners.set(source.id, listener); return () => listeners.delete(source.id); },
  });
  const tree = { elements: [{ kind: "tree", key: "t1", empty: "없음", nodes: [{ key: "n", label: "가지", children: [{ key: "c", label: "잎" }] }] }] };
  declaredWorld.pull = () => { pulls += 1; return Promise.resolve({ seq: 1, value: tree }); };
  const container = document.createElement("div");
  container.className = "set";
  document.body.append(container);
  try {
    const set = { id: "set-d3", title: "세트", layout: "list", sections: [`${plugin}.view`] };
    drawSet(container, "rail-d3", set, { card: "rail-d3", surface: "view-a", orientation: "vertical" });
    await settle();
    const body = container.querySelector(".set__body");
    const report = () => sidebarsState().find((item) => item.sidebar === "rail-d3").sections[0];
    assert.equal(report().mounted, true, "the accepted tree value was not drawn");
    assert.equal(body.textContent, "가지", "the accepted tree value was not drawn");
    assert.equal(pulls, 1, "the source was not pulled once at the load");
    drawSet(container, "rail-d3", set, { card: "rail-d3", surface: "view-a", orientation: "horizontal" });
    await settle();
    assert.equal(report().mounted, true, "the tree was not drawn in a horizontal section");
    assert.equal(report().error, null, "the tree in a horizontal section reported an error");
    assert.equal(body.textContent, "가지", "the tree was not drawn in a horizontal section");
    assert.equal(pulls, 1, "the orientation change pulled the source");
    drawSet(container, "rail-d3", set, { card: "rail-d3", surface: "view-a", orientation: "vertical" });
    await settle();
    assert.equal(report().mounted, true, "the tree was not kept after the orientation returned");
    assert.equal(body.textContent, "가지", "the tree was not kept after the orientation returned");
    assert.equal(pulls, 1, "the orientation change pulled the source");
  } finally {
    clearSet(container);
    container.remove();
  }
});

test("a declared body stacks its elements in vertical orientation and wraps them in one row in horizontal orientation", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  const styled = new JSDOM(`<style>${css}</style><div class="set" data-layout="list" data-orientation="horizontal"><div class="set__body" data-declared=""></div></div><div class="set" data-layout="list" data-orientation="vertical"><div class="set__body" data-declared=""></div></div>`);
  try {
    const [horizontal, vertical] = styled.window.document.querySelectorAll(".set__body");
    const style = styled.window.getComputedStyle(horizontal);
    assert.equal(style.display, "flex", "the horizontal declared body is not a flex container");
    assert.equal(style.flexDirection, "row", "the horizontal declared body does not lay its elements in a row");
    assert.equal(style.flexWrap, "wrap", "the horizontal declared body does not wrap its elements");
    assert.equal(styled.window.getComputedStyle(vertical).flexDirection, "column", "the vertical declared body does not stack its elements");
  } finally {
    styled.window.close();
  }
});
