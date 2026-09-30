import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

// 실제 검사 준비 중 실패를 주입하여 임시 off 선택의 복원을 검사한다.
for(const file of ['window-sidebars.test.mjs','window-sidebar-persistence.test.mjs'])test(`${file} restores card selections after setup fails`, async()=>{
 const source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const original={left:{set:'original'},right:{size:144},top:{set:'off'},bottom:{collapsed:true}};
 const saved=structuredClone(original),cleanups=[];
 const card={id:'card',tabs:[{plugin:'shell'},{plugin:'terminal'}]};
 let disabled=0,result;
 const s={client:{endpoint:{}},cleanup:fn=>cleanups.push(fn),presented:async()=>{},
  get:async name=>{
   if(name==='core.grid')return {cards:[card]};
   if(name==='core.sidebars')return [{placement:'window',card:'card'}];
   if(name==='core.layout')return {state:{cards:[{id:'card',data:{sidebars:structuredClone(saved)}}]}};
   throw new Error('unexpected status '+name);
  },
  run:async(name,params)=>{
   if(name==='core.settings.theme'||name==='core.settings.set')return;
   assert.equal(name,'core.card.sidebar.set');
   if(params.set==='inherit')delete saved[params.side].set;
   else saved[params.side].set=params.set;
   if(params.set==='off'&&++disabled===4)throw new Error('fixture setup failure');
  }};
 runInNewContext(source.slice(source.indexOf('for(const app of Object.values(APPS))test(')),{
  assert,APPS:{fixture:{name:'fixture'}},console:{info:()=>{}},open:async()=>s,fresh:async()=>{},
  test:(_name,_options,callback)=>{result=callback({diagnostic:()=>{}});}});
 await assert.rejects(result,/fixture setup failure/);
 for(const cleanup of cleanups.reverse())await cleanup();
 assert.deepEqual(saved,original,'temporary off selections remain after the window checker');
});
