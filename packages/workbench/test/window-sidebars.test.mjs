import assert from "node:assert/strict";
import test from "node:test";

const units = [{id:"pane"},{id:"tree"}];
const cards = () => [{id:"a",data:{tabs:[{id:"p1",plugin:"pane"},{id:"t1",plugin:"tree"}],activeId:"p1"}},
 {id:"b",data:{tabs:[{id:"p2",plugin:"pane"}],activeId:"p2"}}];
const api = () => import("../window-sidebars.js");

test("window sidebar descriptors retain multiple owners and deterministic edge order", async () => {
 const {windowSidebarCards} = await api();
 const links=[{place:"window-left",plugin:"tree",set:"tree"},{place:"window-left",plugin:"pane",set:"pane"},{place:"left",plugin:null,set:"general"}];
 assert.deepEqual(windowSidebarCards(units,links).map(x=>x.id),["left","window:pane:left","window:tree:left"]);
});
test("saved window owners stay stable across active-tab changes and move with their tab", async () => {
 const {restoreWindowSidebars,reconcileWindowSidebars,windowOwner} = await api();
 const initial=cards();
 const records=restoreWindowSidebars({"window:pane:left":{width:190,owner:"p1"}},units,initial);
 initial[0].data.activeId="t1";
 reconcileWindowSidebars(records,[{id:"window:pane:left",plugin:"pane"}],initial,190);
 assert.equal(windowOwner(records,"window:pane:left",initial).card,"a");
 assert.equal(windowOwner(records,"window:pane:left",initial).available,false);
 initial[1].data.tabs.push(initial[0].data.tabs.shift());
 assert.equal(windowOwner(records,"window:pane:left",initial).card,"b");
 initial[1].data.tabs=initial[1].data.tabs.filter(t=>t.id!=="p1");
 reconcileWindowSidebars(records,[{id:"window:pane:left",plugin:"pane"}],initial,190);
 assert.equal(records["window:pane:left"].owner,"p2");
 assert.equal(records["window:pane:left"].width,190);
});
test("invalid saved window data is rejected instead of choosing a replacement owner", async () => {
 const {restoreWindowSidebars}=await api();
 for(const saved of [null,[],{"window:missing:left":{width:190,owner:null}},{left:{width:NaN,owner:null}},
  {left:{width:190,owner:"p1"}},{"window:pane:left":{width:190,owner:"missing"}},{"window:pane:left":{width:190,owner:"t1"}},
  {"window:pane:left":{width:190,owner:"p1",extra:true}}]) assert.throws(()=>restoreWindowSidebars(saved,units,cards()),/window sidebar/);
});
