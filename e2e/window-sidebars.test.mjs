// 창 사이드바의 포커스 독립 기하와 저장 연결 대상을 실제 호스트 기록으로 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import {rmSync} from "node:fs";
import {APPS,fresh,open} from "./app.mjs";
import {frames,readFrame,pixel} from "./frame.mjs";
const geometry=grid=>grid.cards.map(({id,x,y,w,h})=>({id,x,y,w,h})).sort((a,b)=>a.id.localeCompare(b.id));
const groups=rail=>rail.groups.map(({card,sidebars,path,loops})=>({card,sidebars,path,loops}));
function borders(frame,grid,cards){
 const scale=frame.scale*frame.contentScale;
 for(const card of cards) for(const edge of [card.x,card.x+card.w-1]) {
  const at=edge+grid.plane.x;
  assert.ok([-0.5,0,0.5,1].some(offset=>[-24,-12,12,24].every(delta=>{
   const x=Math.floor(frame.content.x*frame.scale+(at+offset)*scale);
   const y=Math.floor(frame.content.y*frame.scale+(grid.plane.y+card.y+card.h/2+delta)*scale);
   return pixel(frame,x,y).every((value,index)=>Math.abs(value-[43,46,61][index])<=3);
  })),`window sidebar ${card.id} lost its ${edge===card.x?'left':'right'} border at ${frame.time}ms`);
 }
}
for(const app of Object.values(APPS))test(`${app.name}: external sidebar geometry and ownership survive focus and different-plugin tabs`,{timeout:90000},async t=>{
 const s=await open(t,app);assert.ok(s,'required host is not built');
 t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
 await fresh(s);await s.run('core.settings.theme',{name:'midnight',mode:'dark'});
 const initial=await s.get('core.grid');
 const target=initial.cards.find(card=>new Set(card.tabs.map(tab=>tab.plugin)).size>1);assert.ok(target,'different-plugin tabs are required');
 for(const side of ['left','right','top','bottom'])await s.run('core.card.sidebar.set',{card:target.id,side,set:'off'});
 await s.presented();
 const baseline=await s.get('core.grid');
 const windows=baseline.cards.filter(card=>card.id==='left'||card.id==='right'||card.id.startsWith('window:'));
 assert.equal(windows.filter(card=>card.id.startsWith('window:')).length,2,'both declared plugin window sidebars must exist');
 const right = windows.filter(card=>card.id.startsWith('window:')&&card.id.endsWith(':right')).sort((a,b)=>b.x-a.x);
 assert.deepEqual(right.map(card=>card.id),['window:shell:right','window:browser:right'],'window columns violate declared plugin order');
 for (const card of windows) assert.equal(card.h,baseline.height,'a window sidebar does not span the work area');
 const beforeGroups=groups(await s.get('core.rail'));
 assert.equal(beforeGroups.length,2,'both window associations must be exposed');
 const beforeBars=(await s.get('core.sidebars')).filter(bar=>bar.placement==='window');
 assert.equal(beforeBars.length,windows.length);
 const recording=await s.request('diagnostics.capture.start',{});
 let displayed=0,stop;
 try {
  try {
   for(const tab of target.tabs) {
    await s.run('core.tab.select',{tab:tab.id});
    await s.until('core.grid',grid=>grid.cards.find(card=>card.id===target.id)?.active===tab.id,'tab selection did not settle');
    ({displayed}=await s.presented());
    assert.deepEqual(geometry(await s.get('core.grid')),geometry(baseline),'tab selection changed external or content geometry');
    assert.deepEqual(groups(await s.get('core.rail')),beforeGroups,'tab selection retargeted a border group');
   }
   for(const card of baseline.cards.filter(card=>card.tabs.length)) {
    await s.run('core.card.focus',{card:card.id});
    ({displayed}=await s.presented());
    assert.deepEqual(geometry(await s.get('core.grid')),geometry(baseline),'focus changed card geometry');
    assert.deepEqual(groups(await s.get('core.rail')),beforeGroups,'focus retargeted a border group');
   }
  } finally {stop=await s.request('diagnostics.capture.stop',{after:displayed?displayed+100:0});}
  assert.equal(stop.limited,false);assert.ok(stop.longestGap<=100,`recording gap ${stop.longestGap}ms`);
  const captured=frames(recording.frames).map(readFrame);assert.ok(captured.length>2,'incomplete focus/tab recording');
  for(const frame of captured)borders(frame,baseline,windows);
  const afterBars=(await s.get('core.sidebars')).filter(bar=>bar.placement==='window');
  assert.deepEqual(afterBars.map(({sidebar,card,surface,set})=>({sidebar,card,surface,set})),beforeBars.map(({sidebar,card,surface,set})=>({sidebar,card,surface,set})));
  assert.equal((await s.get('core.verify')).rows.find(row=>row.name==='V0 레일 외곽선').ok,true);
  assert.deepEqual((await s.get('core.page.audit')).unbound,[]);
  t.diagnostic(`stable windows=${windows.map(card=>card.id).join(',')}; groups=${beforeGroups.map(group=>group.loops.length)}; frames=${captured.length}; gap=${stop.longestGap}ms`);
 } finally {rmSync(recording.frames,{recursive:true,force:true});}
});
