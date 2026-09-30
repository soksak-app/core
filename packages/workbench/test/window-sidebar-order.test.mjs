import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import {windowSidebar, windowSidebarCards, reconcileWindowSidebars} from "../window-sidebars.js";

// 판의 공개 열 이동 경계를 제어하여 실제 settle 함수를 실행한다.
const source=readFileSync(new URL('../plane.js',import.meta.url),'utf8');
const begin=source.indexOf('function settle() {');
const end=source.indexOf('\n}\n',begin);
assert.ok(begin>=0&&end>begin);
for(const side of ['left','right'])test(`window ${side} sidebar retains its edge and width across plugin overrides`,()=>{
 const units=[{id:'alpha'},{id:'beta'}];
 const links=[{place:side,plugin:null,set:'general'},...units.map(unit=>({place:`window-${side}`,plugin:unit.id,set:unit.id}))];
 let cards=[{id:'content',data:{tabs:[],activeId:null}}];
 const moves=[];
 const position=()=>cards.forEach((card,index)=>Object.assign(card,{c0:index,c1:index+1}));
 const grid={get cards(){position();return cards;},card:id=>cards.find(card=>card.id===id),lines:()=>Array.from({length:cards.length+1},(_,i)=>i),
  canInsertAt:()=>true,insertAt:(_,line,card)=>{cards.splice(line,0,{...card,width:card.size});position();},setFixed:()=>{},
  moveTo:(id,_,line)=>{const index=cards.findIndex(card=>card.id===id);const [card]=cards.splice(index,1);cards.splice(line===0?0:cards.length,0,card);moves.push(id);position();return true;}};
 let focus="alpha";
 const context={grid,closePicker:()=>{},windowSidebarCards,windowSidebar,reconcileWindowSidebars,
  focusedPlugin:()=>focus,pluginUnits:()=>units,value:key=>key==='links'?links:key==='sidebarWidth'?190:key===side,
  windowSidebars:{},isPlace:id=>windowSidebar(id)!==null,dismiss:()=>assert.fail('unexpected removal'),
  focusedId:'content',view:{render:()=>{}},syncBackgroundSessions:()=>{}};
 runInNewContext(source.slice(begin,end+2),context);
 context.settle();
 const outside=cards.filter(card=>card.id!=='content').map(card=>card.id);
 if(side==='right')outside.reverse();
 assert.deepEqual(outside,[side]);
 const sidebar=grid.card(side);
 sidebar.width=230;
 focus="beta";
 const count=moves.length;
 context.settle();
 assert.equal(moves.length,count,'overrides must not move fixed columns');
 assert.equal(grid.card(side),sidebar);
 assert.equal(sidebar.width,230);
 assert.equal(context.windowSidebars[side].width,230);
});
