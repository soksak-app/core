import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
const source=readFileSync(new URL("../verify.js",import.meta.url),"utf8");
const start=source.indexOf('  // 창 사이드바의 배치와 폭을 검증한다.');
const end=source.indexOf('  // W ',start);
test("placement verification checks every window sidebar's requested extent",()=>{
 const cards=[{id:"window:a:right",width:190,c0:1,c1:2,r0:0,r1:1,fixed:true},
  {id:"window:b:right",width:190,c0:2,c1:3,r0:0,r1:1,fixed:true}];
 for (const [secondWidth, expected] of [[210,false],[190,false]]) {
 const rows=[];
 runInNewContext(source.slice(start,end),{grid:{cards,card:id=>cards.find(card=>card.id===id),
  rect:id=>({w:id==='window:a:right'?190:secondWidth}),lines:axis=>axis==='x'?[0,1,2,3]:[0,1]},
  isPlace:id=>id.startsWith('window:'),windowSidebar:()=>({side:'right'}),add:(...row)=>rows.push(row)});
 assert.equal(rows[0][1],expected,'duplicate right columns must be rejected even when both extents match');
 }
});
