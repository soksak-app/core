import assert from "node:assert/strict";
import test from "node:test";

const model = await import("../card-sidebars.js");
const defaults = { size: 190, min: 120, max: 480 };
const sets = { first: { id: "first" }, second: { id: "second" } };
const card = () => ({ id: "fixture", data: {} });

test("derived side layout stays independent of set assignment", () => {
  for (const side of model.SIDEBAR_SIDES) {
    const c = card();
    model.sizeSidebar(c, side, 240, defaults, sets.first);
    model.toggleSidebar(c, side, defaults, sets.first, false);
    assert.equal(Object.hasOwn(c.data.sidebars[side], "set"), false);
    assert.deepEqual(model.effectiveSidebar(c, side, defaults, sets.second), {
      set: "second", size: 240, collapsed: true,
    });
  }
});

test("explicit assignment, off, and inherit have distinct meanings", () => {
  const c = card();
  model.setSidebar(c, "left", "second", sets);
  assert.equal(model.effectiveSidebar(c, "left", defaults, sets.first).set, "second");
  model.setSidebar(c, "left", "off", sets);
  assert.equal(model.effectiveSidebar(c, "left", defaults, sets.first), null);
  model.setSidebar(c, "left", "inherit", sets);
  assert.equal(model.effectiveSidebar(c, "left", defaults, sets.first).set, "first");
});

test("invalid sidebar operations leave the card unchanged", () => {
  const c = card();
  model.setSidebar(c, "right", "first", sets);
  const before = structuredClone(c);
  for (const run of [
    () => model.setSidebar(c, "middle", "first", sets),
    () => model.setSidebar(c, "right", "missing", sets),
    () => model.sizeSidebar(c, "right", NaN, defaults, sets.first),
    () => model.sizeSidebar(c, "right", 100, defaults, sets.first),
  ]) {
    assert.throws(run);
    assert.deepEqual(c, before);
  }
});

test("a removed assigned set is an explicit error and remains assigned", () => {
  const c = card();
  model.setSidebar(c, "top", "first", sets);
  assert.throws(() => model.resolveSidebarSet(c, "top", {}, defaults, null), /unknown sidebar set first/);
  assert.equal(c.data.sidebars.top.set, "first");
});

test("invalid persisted sidebar state and obsolete state are reported", () => {
  for (const data of [
    { sidebars: null }, { sidebars: [] }, { sidebars: { middle: {} } },
    { sidebars: { left: null } }, { sidebars: { left: { set: null } } },
    { sidebars: { left: { collapsed: "false" } } },
    { sidebars: { left: { size: NaN } } },
    { sidebars: { left: { size: 100 } } },
    { sidebars: { left: { unexpected: true } } },
    { panels: {} }, { sidebar: {} },
  ]) {
    const c = { id: "fixture", data };
    assert.throws(() => model.effectiveSidebar(c, "left", defaults, sets.first),
      /invalid|obsolete/, JSON.stringify(data));
  }
});

test("a folded sidebar keeps its divider visible", async () => {
  const { JSDOM } = await import("jsdom");
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app.css", import.meta.url), "utf8");
  for (const side of model.SIDEBAR_SIDES) {
    const dom = new JSDOM(`<style>${css}</style><div class="card" data-sidebar-${side}="folded"><aside class="card-sidebar" data-side-of="${side}"><div class="set"></div><div class="card-sidebar__grip" data-side-of="${side}"></div></aside></div>`);
    try {
      assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector(".set")).display, "none");
      assert.notEqual(dom.window.getComputedStyle(dom.window.document.querySelector(".card-sidebar__grip")).display, "none",
        `folded ${side} divider is hidden`);
    } finally { dom.window.close(); }
  }
});

test("an open sidebar keeps its whole divider input area inside the sidebar", async () => {
  const { JSDOM } = await import("jsdom");
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../app.css", import.meta.url), "utf8");
  const inner = {top:"bottom",bottom:"top",left:"right",right:"left"};
  for (const side of model.SIDEBAR_SIDES) {
    const dom = new JSDOM(`<style>${css}</style><article class="card" data-sidebar-${side}="open"><aside class="card-sidebar" data-side-of="${side}"><div class="card-sidebar__grip" data-side-of="${side}"></div></aside></article>`);
    try {
      const style = dom.window.getComputedStyle(dom.window.document.querySelector(".card-sidebar__grip"));
      assert.equal(style[inner[side]], "0px", `${side}: divider center is outside the sidebar's clipped input area`);
    } finally {dom.window.close();}
  }
});

test('presentation folds an insufficient axis and restores expansion without changing saved choices',()=>{
 const requested=Object.fromEntries(['top','bottom','left','right'].map(side=>[side,{set:'first',size:120,collapsed:false}]));
 const before=structuredClone(requested);
 const metrics={header:32,footer:22,border:1,divider:6,minimum:96,sidebarMinimum:120};
 const narrow=model.presentSidebars(requested,{w:984,h:343.5},metrics);
 // 높이 공간 191.5 에 120 두 개가 최소 크기로도 들어가지 않으므로 위는 120 으로 열고 아래만 접는다.
 assert.equal(narrow.top.collapsed,false);
 assert.equal(narrow.top.shownSize,120);
 assert.equal(narrow.bottom.collapsed,true);
 assert.equal(narrow.bottom.requestedCollapsed,false);
 assert.equal(narrow.bottom.autoCollapsed,true);
 assert.equal(narrow.bottom.collapseReason,'insufficient-height');
 for(const side of ['left','right'])assert.equal(narrow[side].collapsed,false);
 const fullscreen=model.presentSidebars(requested,{w:1186,h:670},metrics);
 for(const side of Object.keys(requested))assert.equal(fullscreen[side].collapsed,false);
 requested.left.collapsed=true;
 assert.equal(model.presentSidebars(requested,{w:1186,h:670},metrics).left.requestedCollapsed,true);
 assert.deepEqual(before.top,requested.top);
 assert.deepEqual(before.bottom,requested.bottom);
});

test('presentation uses the inclusive minimum boundary and rejects invalid geometry',()=>{
 const states={left:{set:'first',size:120,collapsed:false},right:{set:'first',size:120,collapsed:false}};
 const metrics={header:32,footer:22,border:1,divider:6,minimum:96,sidebarMinimum:120};
 assert.equal(model.presentSidebars(states,{w:338,h:400},metrics).right.collapsed,false);
 assert.equal(model.presentSidebars(states,{w:337.5,h:400},metrics).left.collapsed,false);
 assert.equal(model.presentSidebars(states,{w:337.5,h:400},metrics).right.collapseReason,'insufficient-width');
 for(const rect of [{w:NaN,h:400},{w:-1,h:400},{w:400,h:Infinity}])assert.throws(()=>model.presentSidebars(states,rect,metrics),/invalid sidebar presentation/);
});

test("a stored panel size is drawn on the device-pixel grid without changing the stored size", () => {
  assert.equal(model.deviceGridSize(120.5, 1), 121);
  assert.equal(model.deviceGridSize(130.25, 2), 130.5);
  assert.equal(model.deviceGridSize(140.75, 2), 141);
  assert.equal(model.deviceGridSize(120.5, 2), 120.5);
  assert.throws(() => model.deviceGridSize(120, 0), /invalid sidebar size or device pixel ratio/);
});

test("the status names the sides that stay folded for lack of space after the user opened them", () => {
  const open = { collapsed: false, requestedCollapsed: false, autoCollapsed: false };
  const space = { collapsed: true, requestedCollapsed: false, autoCollapsed: true };
  const chosen = { collapsed: true, requestedCollapsed: true, autoCollapsed: true };
  assert.equal(model.spaceFoldText({ top: space, bottom: space, left: open }), "위·아래 사이드바: 공간 부족으로 접힘");
  assert.equal(model.spaceFoldText({ left: space }), "왼쪽 사이드바: 공간 부족으로 접힘");
  // 사용자가 접은 면은 공간과 관계없이 접혀 있으므로 이유를 보이지 않는다.
  assert.equal(model.spaceFoldText({ top: chosen, left: open }), null);
  assert.equal(model.spaceFoldText({}), null);
});

test("a sidebar grip names its side in Korean", () => {
  assert.equal(model.sideName("top"), "위");
  assert.equal(model.sideName("right"), "오른쪽");
  assert.throws(() => model.sideName("middle"), /unknown sidebar side middle/);
});

const METRICS = { header: 32, footer: 22, border: 1, divider: 6, minimum: 96, sidebarMinimum: 120 };
const open = (size) => ({ set: "first", size, collapsed: false });

test("a side that fits opens although the two sides of its axis do not fit together", () => {
  // 보고된 카드: 높이 342.4, 위 190, 아래 120. 높이 공간은 190.4 이다.
  const shown = model.presentSidebars({ top: open(190), bottom: open(120) }, { w: 762, h: 342.4 }, METRICS);
  assert.equal(shown.top.collapsed, false);
  assert.ok(Math.abs(shown.top.shownSize - 184.4) < 1e-9, `${shown.top.shownSize}`);
  assert.equal(shown.bottom.collapsed, true);
  assert.equal(shown.bottom.collapseReason, "insufficient-height");
  // 마지막으로 조작한 면이 아래면 아래를 저장 크기로 열고 위를 접는다.
  const last = model.presentSidebars({ top: open(190), bottom: open(120) }, { w: 762, h: 342.4 }, METRICS, { height: "bottom" });
  assert.equal(last.bottom.collapsed, false);
  assert.equal(last.bottom.shownSize, 120);
  assert.equal(last.top.collapsed, true);
  assert.equal(last.top.size, 190, "the stored size is kept");
});

test("two open sides that do not fit at their sizes are shown smaller in proportion", () => {
  const shown = model.presentSidebars({ top: open(300), bottom: open(200) }, { w: 762, h: 600 }, METRICS);
  assert.equal(shown.top.collapsed, false);
  assert.equal(shown.bottom.collapsed, false);
  assert.ok(Math.abs(shown.top.shownSize - 268.8) < 1e-9 && Math.abs(shown.bottom.shownSize - 179.2) < 1e-9,
    `${shown.top.shownSize}, ${shown.bottom.shownSize}`);
  assert.equal(shown.top.size, 300);
});

test("a side beside a side folded by choice uses the room left by the divider", () => {
  const shown = model.presentSidebars({ top: { ...open(190), collapsed: true }, bottom: open(120) }, { w: 762, h: 342.4 }, METRICS);
  assert.equal(shown.bottom.collapsed, false);
  assert.equal(shown.bottom.shownSize, 120);
  assert.equal(shown.top.requestedCollapsed, true);
});

test("a click opens a side shown folded and folds a side shown open", () => {
  const card = { id: "c", data: { sidebars: { top: { set: "first", collapsed: false } } } };
  const defaults = { size: 190, min: 120, max: 480 };
  model.toggleSidebar(card, "top", defaults, null, true);
  assert.equal(card.data.sidebars.top.collapsed, false, "a click on a side folded for lack of space must not store a fold");
  model.toggleSidebar(card, "top", defaults, null, false);
  assert.equal(card.data.sidebars.top.collapsed, true);
});

test("a drag stores an open choice with the size", () => {
  const card = { id: "c", data: { sidebars: { top: { set: "first", collapsed: true } } } };
  model.sizeSidebar(card, "top", 150, { size: 190, min: 120, max: 480 }, null);
  assert.deepEqual(card.data.sidebars.top, { set: "first", collapsed: false, size: 150 });
});

