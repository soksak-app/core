// 카드 사방 손잡이의 네이티브 포인터 입력과 녹화한 경계 좌표를 검사한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { APPS, fresh, open } from './app.mjs';
import { frames, readFrame, pixel } from './frame.mjs';

const sides = ['top','bottom','left','right'];
const sign = side => side === 'top' || side === 'left' ? 1 : -1;
function near(actual,expected,label) {
  assert.ok(Math.abs(actual-expected)<=1,`${label}: actual ${actual}, expected ${expected}`);
}
async function measure(s,id) {
  const grid = await s.get('core.grid');
  const card = grid.cards.find(c=>c.id===id);
  const surface = (await s.surfaces()).find(item=>item.surface===card.active);
  assert.ok(surface?.applied,'active native surface is not presented');
  const bands = Object.fromEntries(sides.map(side=>[side,card.sidebars[side].collapsed?6:card.sidebars[side].size]));
  near(surface.applied.x,grid.plane.x+card.x+1+bands.left,'native left');
  near(surface.applied.y,grid.plane.y+card.y+1+32+bands.top,'native top');
  near(surface.applied.w,card.w-2-bands.left-bands.right,'native width');
  near(surface.applied.h,card.h-2-32-22-bands.top-bands.bottom,'native height');
  return {grid,card,surface};
}
function border(frame,side,at,cross) {
  const ratio=frame.scale*frame.contentScale;
  const vertical=side==='left'||side==='right';
  const offsets=[-12,-6,0,6,12];
  return offsets.every(offset=>{
    const point=vertical?[at,cross+offset]:[cross+offset,at];
    const rgb=pixel(frame,Math.floor(point[0]*ratio),Math.floor(point[1]*ratio));
    return rgb.every((value,index)=>Math.abs(value-[43,46,61][index])<=3);
  });
}
function recordedEdges(captured,side,initial,cross) {
  return captured.map(frame=>{
    const matches=[];
    for(let step=-2;step<=42;step+=0.5){
      const coordinate=initial+sign(side)*step;
      if(border(frame,side,coordinate,cross)) matches.push(coordinate);
    }
    assert.ok(matches.length,`${side}: frame ${frame.time} has no measured sidebar border`);
    return matches;
  });
}

for(const app of Object.values(APPS)) {
  test(`${app.name}: native pointer drags all four card sidebar borders by their displacement`,{timeout:120000},async t=>{
    const s=await open(t,app);
    assert.ok(s,`${app.binary} is not built`);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    await fresh(s);
    await s.run('core.settings.theme',{name:'midnight',mode:'dark'});
    const card=(await s.get('core.grid')).cards.find(c=>c.tabs.some(tab=>tab.plugin==='terminal'));
    assert.ok(card,'no terminal card');
    await s.run('core.tab.select',{tab:card.tabs.find(tab=>tab.plugin==='terminal').id});
    await s.run('core.card.fullscreen',{card:card.id});
    const set=(await s.get('core.settings')).values.sets[0].id;
    for(const side of sides){
      await s.run('core.card.sidebar.set',{card:card.id,side,set});
      await s.run('core.card.sidebar.size',{card:card.id,side,size:120});
    }
    await s.presented();
    const baseline=await measure(s,card.id);
    const audit=await s.collect('core.verify');
    const failures=[];
    async function inactive() {
      const state=await s.get('host.window');
      assert.equal(state.active,false,`synthetic pointer measurement refused: active window, pointer ${JSON.stringify(state.pointer)}`);
      assert.equal(state.occluded,false,'synthetic pointer measurement refused: occluded window');
    }
    try {
      for(const side of sides){
        await inactive();
        const before=await measure(s,card.id);
        const index=sides.indexOf(side);
        const grip=await s.rect('core.card.sidebar.grip',index);
        assert.ok(grip.width>0&&grip.height>0,`${side}: no grip input area`);
        const x=grip.x+grip.width/2,y=grip.y+grip.height/2;
        const vertical=side==='left'||side==='right';
        const applied=before.surface.applied;
        const initial=side==='left'?applied.x-1:side==='right'?applied.x+applied.w
          :side==='top'?applied.y-1:applied.y+applied.h;
        const cross=vertical?applied.y+applied.h/2:applied.x+applied.w/2;
        const {frames:directory}=await s.request('diagnostics.capture.start',{});
        let down=false;
        let stopped;
        const elapsed=[];
        const gestureErrors=[];
        try {
          try {
            await s.pointer(x,y,'down');down=true;
            for(const distance of [10,20,30,40,30,20,10,0]){
              await inactive();
              const began=performance.now();
              await s.pointer(x+(vertical?sign(side)*distance:0),y+(vertical?0:sign(side)*distance),'drag');
              await s.until('core.grid',grid=>grid.cards.find(c=>c.id===card.id)?.sidebars?.[side]?.size===120+distance,`${side}: drag did not save ${120+distance} points`);
              await s.presented();
              await inactive();
              const current=await measure(s,card.id);
              assert.equal(current.card.sidebars[side].collapsed,false,'drag folded the sidebar');
              assert.deepEqual([current.card.x,current.card.y,current.card.w,current.card.h],
                [baseline.card.x,baseline.card.y,baseline.card.w,baseline.card.h],'drag changed card geometry');
              const moved=await s.rect('core.card.sidebar.grip',index);
              near(vertical?moved.x-grip.x:moved.y-grip.y,sign(side)*distance,`${side} divider displacement`);
              elapsed.push(Math.round(performance.now()-began));
            }
          } catch(error) {gestureErrors.push(error);} finally {
            try {if(down) await s.pointer(x,y,'up');} catch(error) {gestureErrors.push(error);}
            let displayed;
            try {({displayed}=await s.presented());} catch(error) {gestureErrors.push(error);}
            try {stopped=await s.request('diagnostics.capture.stop',{after:displayed===undefined?0:displayed+100});}
            catch(error) {gestureErrors.push(error);}
          }
          if(gestureErrors.length) throw new AggregateError(gestureErrors,`${side}: pointer input or capture failed`);
          const captured=frames(directory).map(readFrame);
          assert.ok(captured.length>4,`${side}: incomplete gesture recording`);
          assert.equal(stopped.limited,false,'recording exhausted its buffer');
          assert.ok(stopped.longestGap<=100,`${side}: missing frames, gap ${stopped.longestGap}ms`);
          const measured=recordedEdges(captured,side,initial,cross);
          assert.ok(measured[0].some(at=>Math.abs(at-initial)<=1),`${side}: initial border not recorded`);
          const final=initial+sign(side)*40;
          assert.ok(measured.some(matches=>matches.some(at=>Math.abs(at-final)<=1)),`${side}: far border not recorded`);
          assert.ok(measured.at(-1).some(at=>Math.abs(at-initial)<=1),`${side}: restored border not recorded`);
          assert.ok(measured.some(matches=>matches.some(at=>Math.abs(at-initial)>=8&&Math.abs(at-final)>=8)),`${side}: no intermediate movement frame`);
          t.diagnostic(`${side}: 120 -> 160 -> 120 points, ${captured.length} frames, gap ${stopped.longestGap}ms, input/presentation steps ${elapsed.join(',')}ms`);
        } finally {
          try {rmSync(directory,{recursive:true,force:true});} catch(error) {failures.push(error);}
        }
        await s.run('core.card.sidebar.size',{card:card.id,side,size:120});
        await s.presented();
      }
      await s.run('core.card.fullscreen',{card:card.id});
      await s.presented();
      await measure(s,card.id);
    } catch(error) {failures.push(error);} finally {
      try {
        const records=await audit.stop();
        for(const value of records) assert.ok(value&&Array.isArray(value.rows),`invalid verification notification ${JSON.stringify(value)}`);
        const failed=records.flatMap(value=>value.rows).filter(row=>!row.ok);
        if(failed.length) failures.push(new Error(`${failed.length} intermediate verification failures: ${JSON.stringify(failed)}`));
      } catch(error) {failures.push(error);}
    }
    if(failures.length) throw new AggregateError(failures,'sidebar gesture measurement failed');
  });
}
