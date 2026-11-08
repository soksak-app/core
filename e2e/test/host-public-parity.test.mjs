import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

async function api() {
  const module = await import("../host-public-parity.mjs");
  assert.equal(typeof module.publicHostState,"function");
  assert.equal(typeof module.comparePublicHostStates,"function");
  return module;
}
function fixture() {
  const rect={x:10,y:20,w:100,h:60};
  return {layout:{window:{content:{width:400,height:300},scale:2,
    surfaces:[{id:"tab-a",visible:true,frame:{x:10,y:20,width:100,height:60}}]},
    document:{width:400,height:300,scale:2},settings:{left:true},project:null,overridden:{}},
    grid:{cards:[{id:"card-a",pane:"pane-a",active:"tab-a",tabs:[{id:"tab-a",plugin:"terminal"}]}]},
    surfaces:[{surface:"tab-a",plugin:"terminal",visible:true,dim:false,declared:{...rect},applied:{...rect},composition:"view",kind:"tab",state:"loaded"}],
    modal:{open:false},hits:{"tab-a":{kind:"document",surface:"tab-a",document:""}}};
}

test("public host parity keeps all three hosts and the declared cross-design geometry criterion",{timeout:1000},async()=>{
  const {publicHostState,comparePublicHostStates}=await api();
  const a=fixture(),b=fixture(),c=fixture();
  b.surfaces[0].declared.x+=0.5;b.surfaces[0].applied.x+=0.5;b.layout.window.surfaces[0].frame.x+=0.5;
  assert.doesNotThrow(()=>comparePublicHostStates({wailsv3:{fresh:publicHostState(a)},tauriv2:{fresh:publicHostState(b)},mygo:{fresh:publicHostState(c)}}));
});
for(const [name,change] of [
  ["applied frame differs",i=>{i.surfaces[0].applied.h+=0.000001;}],
  ["native frame differs",i=>{i.layout.window.surfaces[0].frame.height+=0.000001;}],
  ["native hit belongs to another surface",i=>{i.hits["tab-a"].surface="tab-other";}],
  ["native surface is missing",i=>{i.layout.window.surfaces=[];}],
]) test(`public host parity rejects ${name} without tolerance`,{timeout:1000},async()=>{
  const {publicHostState}=await api();const input=fixture();change(input);
  assert.throws(()=>publicHostState(input),/surface|frame|hit|native/i);
});

test("public host parity rejects a semantic host difference",{timeout:1000},async()=>{
  const {publicHostState,comparePublicHostStates}=await api();const input=fixture();
  input.grid.cards[0].tabs[0].plugin="browser";
  assert.throws(()=>comparePublicHostStates({wailsv3:{fresh:publicHostState(fixture())},tauriv2:{fresh:publicHostState(fixture())},mygo:{fresh:publicHostState(input)}}),/semantic/i);
});

test("public host parity rejects geometry beyond the existing one-point design contract",{timeout:1000},async()=>{
  const {publicHostState,comparePublicHostStates}=await api();const input=fixture();
  input.surfaces[0].declared.x+=1.001;input.surfaces[0].applied.x+=1.001;input.layout.window.surfaces[0].frame.x+=1.001;
  assert.throws(()=>comparePublicHostStates({wailsv3:{fresh:publicHostState(fixture())},tauriv2:{fresh:publicHostState(fixture())},mygo:{fresh:publicHostState(input)}}),/geometry|design/i);
});

test("page transcript consumers stay on main-page hosts while public behavior covers every host",{timeout:1000},()=>{
  const source=readFileSync(new URL("../hosts.test.mjs",import.meta.url),"utf8");
  for(const name of ["every host answers the same page the same way","every host lays out the same page the same way after a resize"]){
    const start=source.indexOf(`test("${name}"`);assert.ok(start>=0);
    const next=source.indexOf("\nif (requiresAll",start+1);const block=source.slice(start,next<0?undefined:next);
    assert.match(block,/all\(t, MAIN_PAGE_APPS\)/);
  }
  assert.match(source,/test\("every host preserves public surface, hit and layout parity through drag, resize and settings"/);
  assert.match(source,/comparePublicHostStates\(/);
  assert.match(source,/publicHostState\(/);
  const menu=source.slice(source.indexOf('test("every host serves the declared application menu"'));
  assert.match(menu,/all\(t\)/);
});
