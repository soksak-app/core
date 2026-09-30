import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import {windowSidebarCards} from "../window-sidebars.js";

const source=readFileSync(new URL('../plane.js',import.meta.url),'utf8');
const start=source.indexOf('function drawRail() {');
const end=source.indexOf('\n}\n',start)+2;
assert.ok(start>=0&&end>start);
function draw(plugin, links) {
 const cards=[{id:'left'},{id:'right'},{id:'content',data:{tabs:[{id:'active',plugin}],activeId:'active'}}];
 const painted=new Map([['left',{x:0,y:0,w:190,h:600}],['content',{x:202,y:0,w:580,h:600}],['right',{x:794,y:0,w:190,h:600}]]);
 const paths=[];
 const context={grid:{cards,gap:12,card:id=>cards.find(card=>card.id===id)},
  focusedId:'content',focusedPlugin:()=>plugin,pluginUnits:()=>[{id:'pane'},{id:'tree'}],value:()=>links,
  windowSidebarCards,windowSidebars:{left:{width:190},right:{width:190}},
  windowOwner:()=>({card:null,surface:null}),isPlace:id=>['left','right'].includes(id),
  view:{painted:id=>painted.get(id)},cardRadius:()=>10,
  outline:rects=>({path:`outline-${rects.length}`,loops:[rects],corners:4,sharp:0}),
  railPath:{setAttribute:(name,path)=>paths.push([name,path])}};
 runInNewContext(source.slice(start,end),context);
 return {result:context.drawRail(),paths};
}
test('general sidebars do not create a rail border',()=>{
 const {result,paths}=draw('pane',[{place:'right',plugin:null,set:'general'}]);
 assert.equal(result.groups.length,0);
 assert.equal(result.shape.path,'');
 assert.equal(paths.at(-1)[1],'');
});
test('only the applied plugin override joins the focused card to fixed sidebars',()=>{
 const links=[{place:'right',plugin:null,set:'general'},
  {place:'window-right',plugin:'pane',set:'pane-set'},
  {place:'window-left',plugin:'tree',set:'tree-set'}];
 const first=draw('pane',links).result;
 assert.equal(first.groups.length,1,'the applied override needs one rail group');
 assert.equal(first.groups[0].card,'content');
 assert.deepEqual(Array.from(first.groups[0].sidebars),['right']);
 const second=draw('tree',links).result;
 assert.equal(second.groups.length,1);
 assert.deepEqual(Array.from(second.groups[0].sidebars),['left']);
});
