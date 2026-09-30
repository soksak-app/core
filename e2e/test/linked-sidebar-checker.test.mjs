import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

// 실제 창 검사 콜백을 실행하고 선언된 상태·명령 경계에 잘못된 결과를 주입한다.
const source=readFileSync(new URL('../card-panels.test.mjs',import.meta.url),'utf8');
const start=source.indexOf('  test(`${app.name}: linked card panels');
const end=source.indexOf('\n  });\n}',start);
assert.ok(start>=0&&end>start,'linked window checker callback is absent');
const block=source.slice(start,end)+'\n  });';
async function check(fault){
 const sides=['top','bottom','left','right'];
 const card={id:'card',active:'tab',tabs:[{id:'tab',plugin:'fixture'}],sidebars:{}};
 const saved={};const values={sets:[{id:'fixture-set'}],links:[]};
 const state={cards:[{id:card.id,data:{sidebars:saved}}]};
 const s={client:{endpoint:{application:'fixture'}},
  get:async name=>{if(name==='core.grid')return {cards:[card]};if(name==='core.settings')return {values};if(name==='core.layout')return {state};throw new Error('unexpected status '+name);},
  run:async(name,params)=>{
   if(name==='core.card.sidebar.set'){assert.equal(params.set,'inherit');saved[params.side]={};return;}
   if(name==='core.settings.set'){
    values.links=params.patch.links;
    for(const side of sides)if(values.links.some(link=>link.place===`card-${side}`))card.sidebars[side]??={set:'fixture-set',size:190,collapsed:true,requestedCollapsed:false,autoCollapsed:true,collapseReason:side==='top'||side==='bottom'?'insufficient-height':'insufficient-width'};
    return;
   }
   const panel=card.sidebars[params.side],own=saved[params.side];
   if(name==='core.card.sidebar.toggle'){
    if(fault!=='noop-fold'){Object.assign(panel,{collapsed:true,requestedCollapsed:true,autoCollapsed:false,collapseReason:null});own.collapsed=true;}
   }else if(name==='core.card.sidebar.size'){panel.size=params.size;if(fault!=='unsaved-size')own.size=params.size;}
   else throw new Error('unexpected command '+name);
   if(fault==='explicit-set')own.set=panel.set;
   if(fault==='unsaved-fold')delete own.collapsed;
  },
  until:async(name,predicate,message)=>{const value=await s.get(name);if(!predicate(value))throw new Error(message);return value;}};
 let result;
 runInNewContext(block,{assert,app:{name:'fixture',binary:'fixture'},open:async()=>s,fresh:async()=>{},keepCommonSettings:async()=>{},
  performance,test:(_,options,callback)=>{result=callback({diagnostic:()=>{}});}});
 await result;
}
for(const fault of ['noop-fold','explicit-set','unsaved-fold','unsaved-size'])test(`linked window checker rejects ${fault}`,async()=>{
 await assert.rejects(check(fault),/linked panels must accept/);
});
test('linked window checker accepts saved derived fold and size results',async()=>{await check(null);});
