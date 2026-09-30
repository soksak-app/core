// 현재 창의 사용자 탭·설정을 보존하며 터미널 오른쪽 설정과 전체화면 복귀를 관측한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {rmSync} from 'node:fs';
import {APPS,open} from '../app.mjs';
import {frames,readFrame} from '../frame.mjs';

for(const app of Object.values(APPS))test(`${app.name}: current terminal right sidebar follows saved plugin settings`,{timeout:90000},async t=>{
 const s=await open(t,app);
 assert.ok(s,'required host is not built');
 const settings=(await s.get('core.settings')).values;
 const initial=await s.get('core.grid');
 assert.equal(initial.fullscreen,null,'start observation from normal card presentation');
 const target=initial.cards.find(card=>card.tabs.find(tab=>tab.id===card.active)?.plugin==='terminal');
 assert.ok(target,'active terminal card is required');
 const link=settings.links.find(link=>link.place==='card-right'&&link.plugin==='terminal');
 assert.ok(link,'a saved terminal card-right assignment is required');
 assert.equal(target.sidebars.right?.set,link.set,'saved terminal setting is suppressed by the card selection');
 const original=(await s.get('core.layout')).state;
 const recording=await s.request('diagnostics.capture.start',{});
 let stop,displayed=0;
 async function measure(mode){
  const bars=await s.until('core.sidebars',bars=>bars.some(bar=>bar.sidebar===`${target.id}:right`&&bar.set===link.set&&!bar.unavailable&&bar.sections.some(section=>section.mounted&&section.text.length>0)&&bar.sections.every(section=>section.error===null)),`${mode}: right section output absent`);
  const grid=await s.get('core.grid'),card=grid.cards.find(card=>card.id===target.id);
  assert.equal(card.sidebars.right.set,link.set);
  const bar=bars.find(bar=>bar.sidebar===`${target.id}:right`);
  assert.equal(bar.orientation,'vertical');assert.ok(bar.rect.w>0&&bar.rect.h>0);
  const native=(await s.get('core.surfaces')).find(surface=>surface.surface===target.active);
  assert.ok(native?.applied,'terminal native rectangle is absent');
  assert.ok(native.applied.w<=card.w-bar.rect.w,'terminal covers its right sidebar');
  assert.deepEqual((await s.get('core.verify')).rows.filter(row=>!row.ok),[]);
  ({displayed}=await s.presented());
  t.diagnostic(`${mode}: card=${JSON.stringify({x:card.x,y:card.y,w:card.w,h:card.h})}; right=${JSON.stringify(bar.rect)}; native=${JSON.stringify(native.applied)}; sections=${bar.sections.map(section=>section.id)}; endpoint=${s.client.endpoint.pid}`);
 }
 try{
  await measure('normal');
  await s.run('core.card.fullscreen',{card:target.id});
  try{await measure('fullscreen');}finally{await s.run('core.card.fullscreen',{card:target.id});}
  await measure('restored');
  assert.deepEqual((await s.get('core.settings')).values,settings);
  assert.deepEqual((await s.get('core.layout')).state,original,'observation changed saved cards or tabs');
 }finally{
  try{
   stop=await s.request('diagnostics.capture.stop',{after:displayed?displayed+100:0});
   const captured=frames(recording.frames).map(readFrame);
   assert.equal(captured.length,stop.count);assert.ok(captured.length>2);
   assert.equal(stop.limited,false);assert.ok(stop.longestGap<=100);
   t.diagnostic(`frames=${stop.count}; gap=${stop.longestGap}ms`);
  }finally{rmSync(recording.frames,{recursive:true,force:true});}
 }
});
