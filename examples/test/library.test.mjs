// 라이브러리 시작, 기존 OS 창 재사용, 폴더 생성·복제와 작업 화면 복원을 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {APPS,nativeProbe} from './app.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,accept,message) {
 const end=Date.now()+15000;let value;
 do {value=await read();if(accept(value))return value;await wait(25);}while(Date.now()<end);
 assert.fail(`${message}: ${JSON.stringify(value)}`);
}
const evaluate=(binary,window,script)=>nativeProbe(binary,{op:'eval',window,match:'main',script});
async function run(binary,window,script) {
 await evaluate(binary,window,`window.__libraryCheck=null;(async()=>{try{window.__libraryCheck={value:await(async()=>{${script}})()??null};}catch(e){window.__libraryCheck={error:e.stack};}})();null`);
 const reply=await until(()=>evaluate(binary,window,'window.__libraryCheck'),Boolean,'library command did not complete');
 assert.equal(reply.error,undefined,reply.error);return reply.value;
}
for(const [name,binary]of Object.entries(APPS))test(`${name}: library windows create and open projects in place`,async t=>{
 const initial=await nativeProbe(binary,{op:'state'},true);if(!initial)return t.skip('host binary is not built');
 const main=initial.window, temporary=realpathSync(mkdtempSync(join(tmpdir(),'soksak-library-')));
 const repository=join(temporary,'repository');mkdirSync(repository);
 execFileSync('git',['init','--quiet',repository]);
 writeFileSync(join(repository,'readme.txt'),'local clone verification');
 execFileSync('git',['-C',repository,'add','.']);
 execFileSync('git',['-C',repository,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','Initial file']);
 const state=()=>nativeProbe(binary,{op:'state',window:main});
 t.after(async()=>{
  for(const window of (await state()).windows)if(window.number!==main)await nativeProbe(binary,{op:'close',window:window.number});
  await until(state,s=>s.windows.length===1,'extra windows did not close');
  await run(binary,main,`const p=await import('./projects.js');for(const item of [...p.all()])if(item.root.startsWith(${JSON.stringify(temporary)}))await p.close(item.id);if(p.all().length)await p.activate(p.all()[0].id);await p.flush();`);
  rmSync(temporary,{recursive:true,force:true});
 });
  const geometry=await run(binary,main,`const plane=document.querySelector('#plane').getBoundingClientRect();
  return [...document.querySelectorAll('.card[data-card-id]')].map(c=>{const r=c.getBoundingClientRect();return {id:c.dataset.cardId,x:r.x-plane.x,y:r.y-plane.y,w:r.width,h:r.height};});`);
 await run(binary,main,`await(await import('./settings.js')).set({projectOpening:'windows'},'common');await(await import('./projects.js')).browse();`);
 assert.equal(await evaluate(binary,main,'document.body.dataset.screen'),'library');
 assert.equal((await state()).views.some(v=>!v.hidden&&v.url.includes('terminal.html')),false);
 assert.equal(await evaluate(binary,main,'document.querySelectorAll(".library-project").length'),1);
 const preview=await evaluate(binary,main,`[...document.querySelectorAll('.library-preview__pane')].map(r=>({id:r.dataset.cardId,x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')}))`);
 assert.deepEqual(preview,geometry,'preview must use the rectangles displayed by the workspace renderer');
 await run(binary,main,`await(await import('./projects.js')).newWindow();`);
 const two=await until(state,s=>s.windows.length===2,'new OS window was not created');
 let child=two.windows.find(w=>w.number!==main).number;
 await until(()=>evaluate(binary,child,'document.querySelectorAll(".library-project").length'),n=>n===1,'new window library did not initialise');
 assert.equal(await run(binary,child,`return(await import('./projects.js')).active();`),null);
 assert.equal((await nativeProbe(binary,{op:'state',window:child})).views.length,1);
 // 실제 라이브러리 생성 폼을 제출한다.
 await evaluate(binary,child,`document.querySelector('[data-action="create"]').click();document.querySelector('[name="name"]').value='created';document.querySelector('[name="parent"]').value=${JSON.stringify(temporary)};document.querySelector('.library-fields').requestSubmit();null`);
 await until(()=>evaluate(binary,child,'document.body.dataset.screen'),s=>s==='workspace','created project did not replace the library');
 assert.equal((await state()).windows.length,2);
 const created=await run(binary,child,`return(await import('./projects.js')).active();`);
 assert.equal(created.root,join(temporary,'created'));assert.equal(existsSync(created.root),true);
 await until(()=>evaluate(binary,child,'document.querySelectorAll(".card[data-card-id]").length'),n=>n>0,'new project cards did not render');
 await evaluate(binary,child,`document.querySelector('button[title="프로젝트 목록"]').click();null`);
 await until(()=>evaluate(binary,child,'document.body.dataset.screen'),s=>s==='library','project list button did not open the library');
 assert.equal(await evaluate(binary,child,'document.body.dataset.screen'),'library');
 await until(()=>evaluate(binary,child,`document.querySelector('[data-filter="open"] span').textContent`),s=>s==='2','open project count is not actual');
 await evaluate(binary,child,`document.querySelector('[data-project-id="${created.id}"] .library-project__pin').click();null`);
 await until(()=>run(binary,child,`return(await import('./projects.js')).all().find(p=>p.id==='${created.id}').pinned;`),Boolean,'pin was not saved');
 await evaluate(binary,child,`const q=document.querySelector('input[type="search"]');q.value='created';q.dispatchEvent(new Event('input'));null`);
 assert.equal(await evaluate(binary,child,'document.querySelectorAll(".library-project").length'),1);
 await run(binary,child,`await(await import('./projects.js')).activate('${created.id}');`);
 assert.equal((await state()).windows.length,2);
 await until(()=>nativeProbe(binary,{op:'state',window:child}),s=>s.views.some(v=>!v.hidden&&v.url.includes('terminal.html')),'return did not restore native content');
 await nativeProbe(binary,{op:'close',window:child});await until(state,s=>s.windows.length===1,'project close did not complete');
 // 미선택 새 창에서 저장된 프로젝트를 열어도 창 수는 증가하지 않는다.
 await run(binary,main,`await(await import('./projects.js')).newWindow();`);
 child=(await until(state,s=>s.windows.length===2,'second library window did not open')).windows.find(w=>w.number!==main).number;
 await until(()=>evaluate(binary,child,'document.querySelectorAll(".library-project").length'),n=>n===2,'saved library did not render');
 await evaluate(binary,child,`document.querySelector('[data-project-id="${created.id}"] .library-project__open').click();null`);
 await until(()=>evaluate(binary,child,'document.body.dataset.screen'),s=>s==='workspace','saved project did not reuse the new window');
 assert.equal((await state()).windows.length,2);
 // 이미 열린 프로젝트는 기존 창을 선택하며, 미선택 창은 그대로 유지한다.
 assert.deepEqual(await nativeProbe(binary,{op:'dock'}),['새 창']);
 await nativeProbe(binary,{op:'dock',select:'새 창'});
 const third=(await until(state,s=>s.windows.length===3,'third library did not open')).windows.find(w=>w.number!==main&&w.number!==child).number;
 await until(()=>evaluate(binary,third,'document.querySelectorAll(".library-project").length'),n=>n===2,'third library did not render');
 await run(binary,third,`await(await import('./projects.js')).activate('${created.id}');`);
 assert.equal((await state()).windows.length,3);
 assert.equal(await run(binary,third,`return(await import('./projects.js')).active();`),null);
 await run(binary,third,`const h=(await import('./framework/index.js')).host;
  for(const name of ['../escape','created']) {
   try { await h.call('projectCreate',{parent:${JSON.stringify(temporary)},name,repository:''}); throw new Error('invalid creation succeeded'); }
   catch(error) { if(error.message==='invalid creation succeeded') throw error; }
  }
  try { await h.call('projectCreate',{parent:${JSON.stringify(temporary)},name:'failed-clone',repository:${JSON.stringify(join(temporary,'missing-repo'))}}); throw new Error('invalid clone succeeded'); }
  catch(error) { if(error.message==='invalid clone succeeded') throw error; }
 `);
 assert.equal(existsSync(join(temporary,'created')),true);
 assert.equal(existsSync(join(temporary,'failed-clone')),false);
 assert.equal(await evaluate(binary,third,'document.body.dataset.screen'),'library');
 await evaluate(binary,third,`document.querySelector('[data-action="clone"]').click();document.querySelector('[name="repository"]').value=${JSON.stringify(repository)};document.querySelector('[name="name"]').value='cloned';document.querySelector('[name="parent"]').value=${JSON.stringify(temporary)};document.querySelector('.library-fields').requestSubmit();null`);
 await until(()=>evaluate(binary,third,'document.body.dataset.screen'),s=>s==='workspace','clone did not reuse the library window');
 assert.equal(existsSync(join(temporary,'cloned','readme.txt')),true);
 assert.equal((await state()).windows.length,3);
 assert.equal(await evaluate(binary,third,'document.querySelector(".library-error").hidden'),true);
 t.diagnostic('same OS window reused for creation, saved projects and clone; Dock menu creates an unassigned library window');
});
