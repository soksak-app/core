import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import {restoreWindowSidebars,windowSidebar} from "../window-sidebars.js";
const source=readFileSync(new URL("../plane.js",import.meta.url),"utf8");
const start=source.indexOf('function restoreWindowState(kept) {');
const end=source.indexOf('\n}',start)+2;
function restore(kept){
 const f={restoreWindowSidebars,windowSidebar,pluginUnits:()=>[{id:"pane",surface:true}],SIDEBAR_SIDES:["left","right","top","bottom"]};
 runInNewContext(source.slice(start,end),f);
 return f.restoreWindowState(kept);
}
test("saved window state rejects obsolete and unknown cards before replacing the displayed layout",()=>{
 for(const card of [{id:"rail-pane"},{id:"window:missing:left"},
  {id:"a",data:{tabs:[{id:"t",plugin:"missing"}],activeId:"t"}},
  {id:"a",data:{tabs:[{id:"t",plugin:"pane"}],activeId:"missing"}}])
  assert.throws(()=>restore({state:{cards:[card]},windowSidebars:{}}),/stored|obsolete|unknown/);
});
test("saved obsolete width fields fail even when empty",()=>{
 for(const field of ["railWidth","edgeWidth"]) assert.throws(()=>restore({state:{cards:[]},[field]:{}}),/obsolete/);
});

for(const field of ['windowSidebars','sidebars'])test(`explicit null ${field} records are rejected instead of becoming empty records`,()=>{
 const base={state:{cards:[]},windowSidebars:{},sidebars:{}};
 assert.throws(()=>restore({...base,[field]:null}),/sidebar/);
});
