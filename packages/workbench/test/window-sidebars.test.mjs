import assert from "node:assert/strict";
import test from "node:test";
import {windowSidebar, windowSidebarCards, restoreWindowSidebars, reconcileWindowSidebars} from "../window-sidebars.js";

const units = [{id:"pane"},{id:"tree"}];
for (const side of ["left", "right"]) {
 test(`${side} edge has one fixed sidebar for multiple plugin overrides`, () => {
  const links = units.map(unit => ({place:`window-${side}`,plugin:unit.id,set:`${unit.id}-set`}));
  const descriptors = windowSidebarCards(units, links, "pane");
  assert.equal(descriptors.length, 1, `${side} edge creates ${descriptors.length} external sidebar cards`);
  assert.equal(descriptors[0].id, side);
  assert.equal(descriptors[0].set, "pane-set");
 });
}
test("focus changes override content without changing sidebar identity or column count", () => {
 const links = [{place:"right",plugin:null,set:"general"},
  {place:"window-right",plugin:"pane",set:"pane-set"},
  {place:"window-right",plugin:"tree",set:"tree-set"}];
 for (const [focus, expectedPlugin, expectedSet] of [["pane","pane","pane-set"],["tree","tree","tree-set"],[null,null,"general"]]) {
  assert.deepEqual(windowSidebarCards(units,links,focus), [{id:"right",side:"right",plugin:expectedPlugin,set:expectedSet}]);
 }
});
test("a configured fixed sidebar remains empty when no general set or matching override exists", () => {
 const links = [{place:"window-right",plugin:"pane",set:"pane-set"}];
 assert.deepEqual(windowSidebarCards(units,links,"tree"), [{id:"right",side:"right",plugin:null,set:null}]);
});
test("saved sidebar widths contain no persistent plugin owner", () => {
 const records = restoreWindowSidebars({left:{width:190},right:{width:210}});
 reconcileWindowSidebars(records,[{id:"left"},{id:"right"}],240);
 assert.deepEqual(records,{left:{width:190},right:{width:210}});
 reconcileWindowSidebars(records,[{id:"left"}],300);
 assert.deepEqual(records,{left:{width:190},right:{width:210}});
});
test("retired plugin sidebar IDs and saved owners are rejected without migration", () => {
 assert.equal(windowSidebar("window:pane:right"), null);
 for (const saved of [null,[],{"window:pane:right":{width:190,owner:null}},
  {left:{width:190,owner:null}}, {right:{width:0}}, {left:{width:NaN}}, {left:{width:190,extra:true}}]) {
  assert.throws(()=>restoreWindowSidebars(saved),/window sidebar/);
 }
});

test("a focused tab of a plugin that is not loaded shows the general window sidebar choice", () => {
  // 불러오지 않은 플러그인의 연결은 내용을 고르지 않는다(docs/spec/plugins.md).
  const links = [{ place: "left", plugin: null, set: "general" }, { place: "window-left", plugin: "absent", set: "kept" }];
  assert.deepEqual(windowSidebarCards([{ id: "probe" }], links, "absent"), [{ id: "left", side: "left", plugin: null, set: "general" }]);
});
