import assert from "node:assert/strict";
import test from "node:test";

const model = await import("../card-sidebars.js");
const defaults = { size: 190, min: 120, max: 480 };
const sets = { first: { id: "first" }, second: { id: "second" } };
const card = () => ({ id: "fixture", data: {} });

test("derived side layout stays independent of set assignment", () => {
  for (const side of model.SIDEBAR_SIDES) {
    const c = card();
    model.toggleSidebar(c, side, defaults, sets.first);
    model.sizeSidebar(c, side, 240, defaults, sets.first);
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
