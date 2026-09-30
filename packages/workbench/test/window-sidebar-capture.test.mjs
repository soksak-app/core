import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
const source=readFileSync(new URL("../plane.js",import.meta.url),"utf8");
const start=source.indexOf('export const capture =');
const end=source.indexOf('/** 보관해 둔 상태',start);
const block=source.slice(start,end).replace('export const','const');
test("space capture records a resized window sidebar even without another settle",()=>{
 const f={grid:{cards:[{id:"left",width:230}],toJSON:()=>({cards:[]})},focusedId:"main",named:0,
  windowSidebars:{left:{width:190}},sidebarChoices:()=>({}),structuredClone,isPlace:id=>id==="left"};
 runInNewContext(block+'\nglobalThis.take = capture;',f);
 assert.equal(f.take().windowSidebars.left.width,230);
});
