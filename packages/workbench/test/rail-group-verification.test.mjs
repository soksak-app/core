import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
const source=readFileSync(new URL("../verify.js",import.meta.url),"utf8");
const begin=source.indexOf('  const { shape, rects: railRects');
const end=source.indexOf('  // V1',begin);
const block=source.slice(begin,end);
test("rail verification counts connected outlines per associated group",()=>{
 const rect=(x)=>({x,y:0,w:100,h:100});
 const groups=[{rects:[rect(0),rect(108)],loops:[[]]},{rects:[rect(250),rect(500)],loops:[[],[]]}];
 const rows=[];
 runInNewContext(block,{railOutline:()=>({shape:{loops:[[],[],[]],corners:12,sharp:0},rects:groups.flatMap(g=>g.rects),groups}),
  grid:{gap:8},cardRadius:()=>8,add:(...row)=>rows.push(row)});
 assert.equal(rows[0][1],true,JSON.stringify(rows));
});
