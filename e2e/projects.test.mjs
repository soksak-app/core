// 파일 저장·설정 상속·프로젝트 창의 실제 네이티브 동작을 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { APPS, nativeProbe } from './app.mjs';

const wait = (ms) => new Promise(resolve => setTimeout(resolve,ms));
async function until(read, accept, message) {
  const end = Date.now()+15000;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await wait(25);
  } while (Date.now()<end);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}
const evaluate = (binary, window, script, match='main') => nativeProbe(binary,{op:'eval',window,match,script});
async function run(binary, window, code) {
  await evaluate(binary,window,`window.__projectCheck = null;
    (async()=>{ try { const result = await (async()=>{ ${code} })();
      window.__projectCheck = {result: result ?? null};
    } catch(e) { window.__projectCheck = {error:String(e),stack:e.stack}; } })(); null`);
  const answer = await until(()=>evaluate(binary,window,'window.__projectCheck'),v=>v!==null,'project operation did not complete');
  assert.equal(answer.error,undefined,answer.stack);
  return answer.result;
}
const settings = (binary, window, patch, scope) => run(binary,window,
  `const s=await import('./settings.js'); await s.set(${JSON.stringify(patch)},${JSON.stringify(scope)}); return s.value('mode');`);
const mode = (binary,window) => run(binary,window,`return (await import('./settings.js')).value('mode');`);
const state = (binary,window) => nativeProbe(binary,{op:'state',window});
const read = (path) => JSON.parse(readFileSync(path,'utf8'));

for (const [name,binary] of Object.entries(APPS)) {
  test(`${name}: project windows persist files, inherit settings, and isolate native state`, async (t) => {
    const initial = await nativeProbe(binary,{op:'state'},true);
    if (!initial) return t.skip(`${binary} is not built`);
    const main = initial.window;
    const temporary = realpathSync(mkdtempSync(join(tmpdir(),'soksak-projects-')));
    const secondRoot = join(temporary,'second'); mkdirSync(secondRoot);
    const thirdRoot = join(temporary,'third'); mkdirSync(thirdRoot);
    const alias = join(temporary,'alias'); symlinkSync(secondRoot,alias);
    let second;
    t.after(async()=>{
      const current = await state(binary,main);
      for (const window of current.windows) if (window.number !== main) {
        await nativeProbe(binary,{op:'close',window:window.number});
      }
      await until(()=>state(binary,main),s=>s.windows.length===1,'project window did not close');
      await run(binary,main,`const p=await import('./projects.js');
        for (const project of [...p.all()]) if (project.root.startsWith(${JSON.stringify(temporary)})) await p.close(project.id);
        if (!p.active() && p.all().length) await p.activate(p.all()[0].id);
        await p.flush();`);
      assert.equal(await evaluate(binary,main,'document.querySelector("#applicationError")?.textContent ?? ""'),'');
      rmSync(temporary,{recursive:true,force:true});
    });

    const first = await run(binary,main,`return (await import('./projects.js')).active();`);
    const config = dirname(first.root);
    await settings(binary,main,{projectOpening:'windows',mode:'light'},'common');
    assert.equal(read(join(config,'settings.json')).mode,'light');
    assert.equal(Object.hasOwn(read(join(first.root,'.soksak/settings.json')),'mode'),false);
    second = await run(binary,main,`const p=await import('./projects.js'),v=await import('./plane.js');
      return p.open({root:${JSON.stringify(secondRoot)},color:'#7fe3b0',layout:v.fresh()});`);
    const created = await until(()=>state(binary,main),s=>s.windows.length===2,'second OS window was not created');
    let child = created.windows.find(w=>w.number!==main).number;
    await until(()=>evaluate(binary,child,'document.querySelectorAll(".card[data-card-id]").length'),n=>n>0,'project cards did not render');
    assert.equal(await run(binary,main,`return (await import('./projects.js')).active().id;`),first.id);
    assert.equal(await run(binary,child,`return (await import('./projects.js')).active().id;`),second.id);
    assert.equal(await mode(binary,child),'light');
    await settings(binary,child,{mode:'dark'},'project');
    assert.deepEqual(read(join(second.root,'.soksak/settings.json')),{mode:'dark'});
    assert.equal(await mode(binary,main),'light');
    await settings(binary,main,{mode:'dark'},'common');
    await settings(binary,main,{mode:'light'},'common');
    assert.equal(await mode(binary,child),'dark');
    await run(binary,child,`await (await import('./settings.js')).reset('mode');`);
    assert.deepEqual(read(join(second.root,'.soksak/settings.json')),{});
    await until(()=>mode(binary,child),m=>m==='light','reset did not restore common settings');
    assert.equal(await run(binary,child,`try { (await import('./settings.js')).set({projectOpening:'tabs'},'project'); return false; } catch { return true; }`),true);

    const reopened = await run(binary,main,`const p=await import('./projects.js'),v=await import('./plane.js');
      return p.open({root:${JSON.stringify(alias)},color:'#fff',layout:v.fresh()});`);
    assert.equal(reopened.id,second.id);
    assert.equal((await state(binary,main)).windows.length,2);
    assert.equal(await run(binary,main,`return (await import('./projects.js')).all().length;`),2);

    const concurrent = await Promise.all([main,child].map(window=>run(binary,window,
      `return (await import('./projects.js')).open({root:${JSON.stringify(thirdRoot)},color:'#7db4ff',layout:(await import('./plane.js')).fresh()});`)));
    assert.equal(concurrent[0].id,concurrent[1].id);
    const shared = await until(()=>state(binary,main),s=>s.windows.length===3,'concurrent opens did not create one shared project window');
    const sharedWindow = shared.windows.find(w=>w.number!==main&&w.number!==child).number;
    await until(()=>evaluate(binary,sharedWindow,'document.querySelectorAll(".card[data-card-id]").length'),n=>n>0,'shared project did not render');
    assert.equal(await run(binary,main,`return (await import('./projects.js')).all().length;`),3);
    await nativeProbe(binary,{op:'close',window:sharedWindow});
    await until(()=>state(binary,main),s=>s.windows.length===2,'shared project did not close');
    await run(binary,main,`await (await import('./projects.js')).close(${JSON.stringify(concurrent[0].id)});`);

    await settings(binary,main,{mode:'dark'},'common');
    await run(binary,child,`(await import('./settings-ui.js')).openSettings();`);
    await until(()=>state(binary,child),s=>s.views.some(v=>!v.hidden&&v.url.includes('overlay.html')),'child settings did not render');
    assert.equal(await evaluate(binary,main,'Boolean(window.__soksakBackground)'),false);
    assert.equal(await evaluate(binary,child,'Boolean(window.__soksakBackground)'),true);
    await run(binary,main,`(await import('./settings-ui.js')).openSettings();`);
    await until(()=>state(binary,main),s=>s.views.some(v=>!v.hidden&&v.url.includes('overlay.html')),'main settings did not render');
    const childModal = (await state(binary,child)).views.find(v=>v.url.includes('overlay.html')).url;
    const scopeTabs = await evaluate(binary,child,`({
      navScopes:document.querySelectorAll('.set-card__nav [data-key^="pick:scope:"]').length,
      tabs:[...document.querySelectorAll('.set-card__pane .set-scope-tabs button')].map(b=>({
        label:b.textContent,selected:b.getAttribute('aria-pressed'),x:b.getBoundingClientRect().x,y:b.getBoundingClientRect().y
      }))
    })`,childModal);
    assert.equal(scopeTabs.navScopes,0);
    assert.deepEqual(scopeTabs.tabs.map(b=>b.label),['전역','프로젝트']);
    assert.deepEqual(scopeTabs.tabs.map(b=>b.selected),['true','false']);
    assert.equal(scopeTabs.tabs[0].y,scopeTabs.tabs[1].y);
    assert.ok(scopeTabs.tabs[0].x<scopeTabs.tabs[1].x);
    await evaluate(binary,child,`document.querySelector('[data-key="pick:scope:project"]').click(); null`,childModal);
    await until(()=>evaluate(binary,child,`Boolean(document.querySelector('[data-key="pick:scope:project"][data-on="true"]'))`,childModal),Boolean,'folder settings scope was not selected');
    assert.equal(await evaluate(binary,child,`Boolean(document.querySelector('[data-key^="pick:projectOpening:"]'))`,childModal),false);
    await evaluate(binary,child,`document.querySelector('[data-key="pick:mode:light"]').click(); null`,childModal);
    await until(()=>mode(binary,child),m=>m==='light','modal did not update its project');
    assert.equal(await mode(binary,main),'dark');
    assert.equal(read(join(second.root,'.soksak/settings.json')).mode,'light');
    assert.equal(read(join(config,'settings.json')).mode,'dark');
    const commonLatency = read(join(config,'settings.json')).latency;
    await evaluate(binary,child,`document.querySelector('[data-key="nav:compositing"]').click();null`,childModal);
    await until(()=>evaluate(binary,child,`Boolean(document.querySelector('[data-set="latency"]'))`,childModal),Boolean,'compositing settings did not open');
    await evaluate(binary,child,`const input=document.querySelector('[data-set="latency"]');input.value='7';input.dispatchEvent(new Event('change',{bubbles:true}));null`,childModal);
    await until(()=>read(join(second.root,'.soksak/settings.json')).latency,n=>n===7,'category change did not retain project scope');
    assert.equal(read(join(config,'settings.json')).latency,commonLatency);
    await until(()=>evaluate(binary,child,`Boolean(document.querySelector('[data-key="reset:latency"]'))`,childModal),Boolean,'project override reset did not appear');
    await evaluate(binary,child,`document.querySelector('[data-key="reset:latency"]').click();null`,childModal);
    await until(()=>read(join(second.root,'.soksak/settings.json')).latency,n=>n===undefined,'project override was not removed');
    await evaluate(binary,child,`document.querySelector('[data-key="nav:general"]').click();null`,childModal);
    await until(()=>evaluate(binary,child,`Boolean(document.querySelector('.set-scope-tabs [data-key="pick:scope:project"][aria-pressed="true"]'))`,childModal),Boolean,'General did not retain the selected project tab');
    await evaluate(binary,child,`document.querySelector('[data-key="pick:scope:common"]').click();null`,childModal);
    await until(()=>evaluate(binary,child,`Boolean(document.querySelector('[data-key^="pick:projectOpening:"]'))`,childModal),Boolean,'Global tab did not display the common-only setting');
    await evaluate(binary,child,`document.querySelector('[data-key="pick:mode:light"]').click();null`,childModal);
    await until(()=>mode(binary,main),m=>m==='light','Global tab did not update the other project');
    assert.equal(read(join(config,'settings.json')).mode,'light');
    await evaluate(binary,child,`document.querySelector('[data-key="pick:scope:project"]').click();null`,childModal);
    await until(()=>evaluate(binary,child,`Boolean(document.querySelector('[data-key="pick:scope:project"][aria-pressed="true"]'))`,childModal),Boolean,'project scope was not selected before leaving the workspace');
    await evaluate(binary,child,`document.querySelector('[data-key="close"]').click(); null`,childModal);
    await until(()=>state(binary,child),s=>!s.views.some(v=>v.url.includes('overlay.html')),'child settings did not close');
    assert.equal((await state(binary,main)).views.some(v=>!v.hidden&&v.url.includes('overlay.html')),true);
    const mainModal = (await state(binary,main)).views.find(v=>v.url.includes('overlay.html')).url;
    await evaluate(binary,main,`document.querySelector('[data-key="close"]').click(); null`,mainModal);
    await until(()=>state(binary,main),s=>!s.views.some(v=>v.url.includes('overlay.html')),'main settings did not close');

    await settings(binary,main,{mode:'dark'},'common');
    const projectSettings = read(join(second.root,'.soksak/settings.json'));
    await run(binary,child,`await (await import('./projects.js')).browse();`);
    assert.equal(await evaluate(binary,child,'document.body.dataset.screen'),'library');
    assert.equal(await mode(binary,child),'dark','library must apply common settings after leaving a project');
    assert.equal(await evaluate(binary,child,'document.documentElement.style.colorScheme'),'dark');
    await run(binary,child,`(await import('./settings-ui.js')).openSettings();`);
    const libraryModal = (await until(()=>state(binary,child),s=>s.views.some(v=>v.url.includes('overlay.html')),'library settings did not open')).views.find(v=>v.url.includes('overlay.html')).url;
    const libraryTabs = await until(()=>evaluate(binary,child,`[...document.querySelectorAll('.set-scope-tabs button')].map(b=>({label:b.textContent,selected:b.getAttribute('aria-pressed')}))`,libraryModal),tabs=>tabs.length>0,'library scope tab did not render');
    assert.deepEqual(libraryTabs,[{label:'전역',selected:'true'}]);
    assert.equal(await evaluate(binary,child,`Boolean(document.querySelector('[data-key^="pick:projectOpening:"]'))`,libraryModal),true);
    await evaluate(binary,child,`document.querySelector('[data-key="pick:mode:light"]').click();null`,libraryModal);
    await until(()=>mode(binary,main),m=>m==='light','library settings did not update common settings');
    assert.equal(read(join(config,'settings.json')).mode,'light');
    assert.deepEqual(read(join(second.root,'.soksak/settings.json')),projectSettings);
    await evaluate(binary,child,`document.querySelector('[data-key="close"]').click();null`,libraryModal);
    await until(()=>state(binary,child),s=>!s.views.some(v=>v.url.includes('overlay.html')),'library settings did not close');
    await evaluate(binary,child,`document.querySelector('button[title="밝게 / 어둡게"]').click();null`);
    await until(()=>mode(binary,main),m=>m==='dark','library appearance action did not update common settings');
    assert.deepEqual(read(join(second.root,'.soksak/settings.json')),projectSettings);
    await run(binary,child,`await (await import('./projects.js')).activate(${JSON.stringify(second.id)});`);
    assert.equal(await mode(binary,child),'light','workspace must restore its project override');
    assert.equal(await evaluate(binary,child,'document.documentElement.style.colorScheme'),'light');
    await run(binary,child,`(await import('./settings-ui.js')).openSettings();`);
    const restoredModal = (await until(()=>state(binary,child),s=>s.views.some(v=>v.url.includes('overlay.html')),'restored workspace settings did not open')).views.find(v=>v.url.includes('overlay.html')).url;
    const restoredTabs = await until(()=>evaluate(binary,child,`[...document.querySelectorAll('.set-scope-tabs button')].map(b=>b.textContent)`,restoredModal),tabs=>tabs.length>0,'restored workspace scope tabs did not render');
    assert.deepEqual(restoredTabs,['전역','프로젝트']);
    await evaluate(binary,child,`document.querySelector('[data-key="close"]').click();null`,restoredModal);
    await until(()=>state(binary,child),s=>!s.views.some(v=>v.url.includes('overlay.html')),'restored workspace settings did not close');

    await settings(binary,main,{projectOpening:'tabs'},'common');
    const third = await run(binary,main,`const p=await import('./projects.js'),v=await import('./plane.js');
      return p.open({root:${JSON.stringify(thirdRoot)},color:'#7db4ff',layout:v.fresh()});`);
    assert.equal((await state(binary,main)).windows.length,2);
    assert.equal(await run(binary,main,`return (await import('./projects.js')).active().id;`),third.id);
    assert.equal(await run(binary,child,`return (await import('./projects.js')).active().id;`),second.id);
    await run(binary,child,`const p=await import('./projects.js'),v=await import('./plane.js');
      const space=p.addSpace(v.fresh()); p.renameSpace(space.id,'Saved space');
      v.currentGrid().setSize("rail-terminal","x",213); v.currentGrid().setSize("left","x",215); v.settle();
      await (await import('./settings.js')).set({left:false},'project'); await p.flush();`);
    const beforeClose = await state(binary,child);
    await nativeProbe(binary,{op:'position',window:child,x:beforeClose.x+30,y:beforeClose.y+20});
    await nativeProbe(binary,{op:'close',window:child});
    await until(()=>state(binary,main),s=>s.windows.length===1,'native close did not complete');
    const saved = read(join(config,'projects.json')).find(p=>p.id===second.id);
    assert.equal(saved.spaces.find(s=>s.id===saved.activeSpaceId).title,'Saved space');
    assert.equal(saved.spaces.find(s=>s.id===saved.activeSpaceId).layout.railWidth.terminal,213);
    assert.ok(saved.geometry.width>0);
    assert.equal((await state(binary,main)).views.some(v=>!v.hidden&&v.url.includes('terminal.html')),true);
    await settings(binary,main,{projectOpening:'windows'},'common');
    await run(binary,main,`await (await import('./projects.js')).activate(${JSON.stringify(second.id)});`);
    child = (await until(()=>state(binary,main),s=>s.windows.length===2,'saved project did not reopen')).windows.find(w=>w.number!==main).number;
    await until(()=>evaluate(binary,child,'document.querySelectorAll(".card[data-card-id]").length'),n=>n>0,'saved project did not render');
    const restored = await run(binary,child,`const p=await import('./projects.js'),v=await import('./plane.js'); return {p:p.active(),layout:v.capture()};`);
    assert.equal(restored.p.activeSpaceId,saved.activeSpaceId);
    assert.equal(restored.layout.railWidth.terminal,213);
    await settings(binary,child,{left:true},'project');
    assert.equal(await run(binary,child,`return (await import('./plane.js')).currentGrid().card('left').width;`),215);
    const afterOpen = await state(binary,child);
    assert.equal(afterOpen.x,beforeClose.x+30);
    assert.equal(afterOpen.y,beforeClose.y+20, JSON.stringify({before:beforeClose, saved:saved.geometry, after:afterOpen}));
    assert.equal(afterOpen.w,beforeClose.w);
    assert.equal(afterOpen.h,beforeClose.h);
    assert.equal(await mode(binary,child),'light');
    await run(binary,main,`await (await import('./projects.js')).activate(${JSON.stringify(first.id)});`);
    assert.equal((await state(binary,main)).windows.find(w=>w.number===main).title, `${first.title} / ${name==='wailsv3'?'Wails v3':'Tauri v2'}`);
    await nativeProbe(binary,{op:'close',window:child});
    await until(()=>state(binary,main),s=>s.windows.length===1,'restored project window did not close');
    await run(binary,main,`const p=await import('./projects.js');
      await p.move(${JSON.stringify(third.id)},-2); await p.rename(${JSON.stringify(third.id)},'First saved project');
      await p.flush();`);
    const origin = await evaluate(binary,main,'performance.timeOrigin');
    await evaluate(binary,main,'location.reload(); null');
    await until(()=>evaluate(binary,main,'performance.timeOrigin'),v=>v!==origin,'main document did not reload');
    await until(()=>run(binary,main,`return (await import('./projects.js')).active()?.id ?? null;`),id=>id===first.id,'reload did not retain the current project');
    assert.equal((await state(binary,main)).windows.length,1);
    assert.equal(await run(binary,main,`return (await import('./projects.js')).all()[0].title;`),'First saved project');
    t.diagnostic('verified common/project JSON files, native modal isolation, directory aliases, tab/window policy, and close/reopen persistence');
  });
}
