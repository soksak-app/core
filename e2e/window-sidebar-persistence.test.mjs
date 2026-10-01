// 창 열과 카드 내부 링크의 독립 저장을 실제 섹션·네이티브 좌표·녹화 경계로 검사한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {rmSync} from 'node:fs';
import {APPS,fresh,open} from './app.mjs';
import {turnOffCardSidebars} from './card-sidebar-choices.mjs';
import {frames,readFrame,pixel} from './frame.mjs';

const geometry=grid=>grid.cards.map(({id,x,y,w,h})=>({id,x,y,w,h})).sort((a,b)=>a.id.localeCompare(b.id));
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1,`${label}: ${actual}, expected ${expected}`);
function borders(frame,grid,cards){
 const scale=frame.scale*frame.contentScale;
 for(const card of cards)for(const edge of [card.x,card.x+card.w-1])assert.ok(
  [-0.5,0,0.5,1].some(offset=>[-24,-12,12,24].every(delta=>{
   const x=Math.floor(frame.content.x*frame.scale+(grid.plane.x+edge+offset)*scale);
   const y=Math.floor(frame.content.y*frame.scale+(grid.plane.y+card.y+card.h/2+delta)*scale);
   return pixel(frame,x,y).every((value,index)=>Math.abs(value-[43,46,61][index])<=3);
  })),`${card.id} border ${edge} absent at ${frame.time}ms`);
}
function nativeBorders(frame,rect){
 const scale=frame.scale*frame.contentScale;
 const sample=(x,y)=>pixel(frame,Math.floor(frame.content.x*frame.scale+x*scale),Math.floor(frame.content.y*frame.scale+y*scale));
 for(const [vertical,coordinate,cross]of [[true,rect.x-1,rect.y+rect.h/2],[true,rect.x+rect.w,rect.y+rect.h/2],[false,rect.y-1,rect.x+rect.w/2]])assert.ok(
  [-1,-0.5,0,0.5,1].some(offset=>[-24,-18,-12,12,18,24].every(delta=>{
   const x=vertical?coordinate+offset:cross+delta,y=vertical?cross+delta:coordinate+offset;
   const rgb=sample(x,y),before=sample(x-(vertical?4:0),y-(vertical?0:4)),after=sample(x+(vertical?4:0),y+(vertical?0:4));
   const background=before.map((value,index)=>(value+after[index])/2);
   const contrast=[43,46,61].map((value,index)=>value-background[index]);
   const norm=contrast.reduce((sum,value)=>sum+value*value,0);if(norm<25)return false;
   const alpha=rgb.reduce((sum,value,index)=>sum+(value-background[index])*contrast[index],0)/norm;
   return alpha>=0.35&&alpha<=1.2&&rgb.every((value,index)=>Math.abs(value-background[index]-alpha*contrast[index])<=3);
  })),`native border ${coordinate} absent at ${frame.time}ms`);
}
for(const app of Object.values(APPS))test(`${app.name}: independent window and card settings survive hiding and project reload`,{timeout:120000},async t=>{
 console.info(`START ${app.name}: window sidebar persistence`);
 const s=await open(t,app);assert.ok(s,'required host is not built');
 t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
 await fresh(s);await s.run('core.settings.theme',{name:'midnight',mode:'dark'});
 await s.run('core.settings.set',{patch:{focusInd:'corner'},scope:'common'});
 const initial=await s.get('core.grid');
 const configured=initial.cards.filter(card=>card.tabs.length===0).map(card=>card.id);
 const target=initial.cards.find(card=>card.tabs.some(tab=>tab.plugin==='terminal'));
 assert.ok(target,'terminal fixture absent');
 const terminal=target.tabs.find(tab=>tab.plugin==='terminal');
 const windowBar=(await s.get('core.sidebars')).find(bar=>bar.placement==='window'&&bar.card===target.id);
 assert.ok(windowBar,'associated external sidebar absent');
 await turnOffCardSidebars(s,target.id);
 await s.run('core.tab.select',{tab:terminal.id});
 const settings=(await s.get('core.settings')).values;
 const source=settings.sets.find(set=>set.sections.includes('files.tree')&&set.sections.includes('files.bookmarks'));
 assert.ok(source,'file section fixture absent');
 const cardSet={...source,id:'window-reload-card',title:'Reload card',layout:'list'};
 let savedRecords,savedSettings,savedSides,restoredGeometry;
 async function measure(label,hidden){
  await s.until('core.settings',value=>!value.saving,`${label}: settings save incomplete`);
  await s.presented();
  const grid=await s.get('core.grid'),layout=await s.get('core.layout');
  const current=grid.cards.find(card=>card.id===target.id);assert.ok(current,`${label}: content card absent`);
  const expectedIDs=configured.filter(id=>!hidden||id!=='right').sort();
  const columns=grid.cards.filter(card=>card.tabs.length===0);
  assert.deepEqual(columns.map(card=>card.id).sort(),expectedIDs,`${label}: configured window columns changed`);
  assert.deepEqual(layout.windowSidebars,savedRecords,`${label}: saved edge width changed`);
  assert.deepEqual((await s.get('core.settings')).values,savedSettings,`${label}: links or settings changed`);
  assert.deepEqual(layout.state.cards.find(card=>card.id===target.id).data.sidebars,savedSides,`${label}: card choices changed`);
  const bars=await s.until('core.sidebars',all=>all.some(bar=>bar.sidebar===`${target.id}:left`&&bar.set===cardSet.id)&&
   all.every(bar=>bar.sections.every(section=>section.error===null&&section.mounted===(bar.layout==='list'||section.id===bar.tab))),`${label}: section output did not settle`);
  const inside=bars.find(bar=>bar.sidebar===`${target.id}:left`);
  assert.equal(inside.placement,'card');assert.equal(inside.orientation,'vertical');
  assert.equal(current.sidebars.left.set,cardSet.id);assert.equal(current.sidebars.left.collapsed,false);
  assert.equal(current.sidebars.left.size,144);assert.deepEqual(inside.sections.map(section=>section.id),cardSet.sections);
  near(inside.rect.w,143,`${label}: internal section width excluding divider`);
  assert.ok(inside.sections.every(section=>section.text.length>0),`${label}: internal section output empty`);
  assert.ok(inside.sections.find(section=>section.id==='files.tree')?.controls>0,`${label}: file tree controls absent`);
  for(const column of columns){
   near(column.w,savedRecords[column.id].width,`${label}: ${column.id} width`);
   near(column.h,grid.height,`${label}: full-height column`);
   const bar=bars.find(item=>item.sidebar===column.id);assert.ok(bar,`${label}: ${column.id} sections absent`);
   const link=savedSettings.links.find(item=>item.place===(column.id==='left'?'left':`window-${bar.side}`)&&item.plugin===bar.plugin);
   assert.equal(bar.set,link.set,`${label}: window assignment`);
   assert.deepEqual(bar.sections.map(section=>section.id),savedSettings.sets.find(set=>set.id===link.set).sections,`${label}: window section output was dropped`);
   assert.ok(bar.sections.filter(section=>section.mounted).every(section=>section.text.length>0),`${label}: ${column.id} output empty`);
   if(column.id===windowBar.sidebar){assert.equal(bar.surface,terminal.id);assert.equal(bar.card,target.id);assert.equal(bar.unavailable,false);}
   for(const [key,value]of Object.entries({x:grid.plane.x+column.x+1,y:grid.plane.y+column.y+1,w:column.w-2,h:column.h-24}))near(bar.rect[key],value,`${label}: ${column.id} DOM ${key}`);
  }
  const surface=(await s.surfaces()).find(item=>item.surface===terminal.id);assert.ok(surface?.applied,`${label}: native surface absent`);
  const expected={x:grid.plane.x+current.x+145,y:grid.plane.y+current.y+33,w:current.w-146,h:current.h-56};
  for(const key of Object.keys(expected)){near(surface.applied[key],expected[key],`${label}: native ${key}`);near(surface.declared[key],expected[key],`${label}: declared ${key}`);}
  const host=await s.get('host.window');assert.equal(host.active,false);assert.equal(host.occluded,false);
  const native=host.surfaces.find(item=>item.id===terminal.id)?.frame;assert.ok(native,`${label}: host frame absent`);
  for(const [key,value]of Object.entries({x:expected.x,y:expected.y,width:expected.w,height:expected.h}))near(native[key],value,`${label}: host ${key}`);
  assert.deepEqual((await s.get('core.verify')).rows.filter(row=>!row.ok),[]);
  assert.deepEqual((await s.get('core.page.audit')).unbound,[]);
  t.diagnostic(`${label}: records=${JSON.stringify(savedRecords)}; native=${JSON.stringify(expected)}; internal=${inside.set}/${inside.rect.w}`);
  return {grid,columns,native:expected};
 }
 async function phase(label,change,hidden=false){
  const began=performance.now();console.info(`START ${app.name}: ${label}`);
  const recording=await s.request('diagnostics.capture.start',{});
  let stopAttempted=false,displayed=0,result;const errors=[];
  try{
   await change();
   result=await measure(label,hidden);({displayed}=await s.presented());
   stopAttempted=true;const stop=await s.request('diagnostics.capture.stop',{after:displayed+100});
   const captured=frames(recording.frames);assert.ok(captured.length>2,`${label}: incomplete capture`);
   assert.equal(captured.length,stop.count,`${label}: reported and written frame counts differ`);
   t.diagnostic(`${label}: ${captured.length} frames; maximum gap ${stop.longestGap}ms; limited=${stop.limited}`);
   assert.equal(stop.limited,false);assert.ok(stop.longestGap<=100,`${label}: missing frames ${stop.longestGap}ms`);
   // 완전한 버퍼를 한 장씩 읽어 검사한다. 모든 장치 픽셀 버퍼를 동시에 보유하지 않는다.
   for(const path of captured)readFrame(path);
   const last=readFrame(captured.at(-1));borders(last,result.grid,result.columns);nativeBorders(last,result.native);
   console.info(`PASS ${app.name}: ${label} (${Math.round(performance.now()-began)}ms)`);
  }catch(error){errors.push(error);}finally{
   try{if(!stopAttempted)await s.request('diagnostics.capture.stop',{after:displayed?displayed+100:0});}catch(error){errors.push(error);}
   try{rmSync(recording.frames,{recursive:true,force:true});}catch(error){errors.push(error);}
  }
  if(errors.length)throw new AggregateError(errors,`${label}: persistence recording failed`);
  return result.grid;
 }
 const assigned=await phase('independent settings and widths',async()=>{
  await s.run('core.settings.set',{patch:{sets:[...settings.sets,cardSet]},scope:'common'});
  await s.run('core.settings.link',{place:`window-${windowBar.side}`,plugin:terminal.plugin,set:source.id,scope:'common'});
  await s.run('core.settings.link',{place:'card-left',plugin:terminal.plugin,set:cardSet.id,scope:'common'});
  await s.run('core.card.sidebar.set',{card:target.id,side:'left',set:'inherit'});
  await s.run('core.card.sidebar.size',{card:target.id,side:'left',size:144});
  await s.run('core.grid.size',{card:windowBar.sidebar,axis:'x',size:215});
  await s.run('core.grid.size',{card:'left',axis:'x',size:207});
  await s.presented();
  savedRecords=(await s.get('core.layout')).windowSidebars;
  assert.deepEqual(Object.keys(savedRecords).sort(),['left','right'],'only fixed edge widths are stored');
  for(const record of Object.values(savedRecords))assert.deepEqual(Object.keys(record),['width'],'a plugin owner was persisted');
  assert.equal(savedRecords[windowBar.sidebar].width,215);assert.equal(savedRecords.left.width,207);
  savedSettings=(await s.get('core.settings')).values;
  savedSides=(await s.get('core.layout')).state.cards.find(card=>card.id===target.id).data.sidebars;
  assert.equal(Object.hasOwn(savedSides.left,'set'),false,'derived link became an explicit card assignment');
 });
 await phase('right edge hidden',async()=>{
  await s.run('core.settings.set',{patch:{right:false},scope:'common'});savedSettings={...savedSettings,right:false};
 },true);
 const restored=await phase('right edge restored',async()=>{
  await s.run('core.settings.set',{patch:{right:true},scope:'common'});savedSettings={...savedSettings,right:true};
 });restoredGeometry=geometry(restored);
 assert.deepEqual(restoredGeometry,geometry(assigned),'edge restoration changed content or window geometry');
 const project=(await s.get('core.project')).id;
 const reloaded=await phase('saved project reloaded',async()=>{
  await s.run('core.projects.flush');const origin=(await s.get('core.window.document')).timeOrigin;
  await s.run('host.window.reload');
  await s.until('core.window.document',doc=>doc.timeOrigin!==origin&&doc.readyState==='complete','document did not reload');
  await s.until('core.project',value=>value?.id===project,'reload lost project');
 });
 assert.deepEqual(geometry(reloaded),restoredGeometry,'reload changed configured geometry');
});
