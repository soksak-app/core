import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { WorkspaceStore } from '../runtime/browser-storage.js';

test('browser persistence shares settings, serializes duplicate directories and preserves record fields', async () => {
  const indexedDB = new IDBFactory();
  const a = await WorkspaceStore.open({indexedDB,channel:false});
  const b = await WorkspaceStore.open({indexedDB,channel:false});
  try {
    const make = (id,root,identity) => ({id,root,identity,title:id,settings:{},spaces:[]});
    const [first,duplicate] = await Promise.all([a.add(make('p1','/root','1')), b.add(make('p2','/alias','1'))]);
    assert.equal(first.id, duplicate.id);
    await Promise.all([a.patch(first.id,{title:'Renamed'}),b.patch(first.id,{geometry:{width:1000,height:800}})]);
    await a.settings(null,{mode:'light',projectOpening:'windows'});
    await b.settings(first.id,{gap:12});
    const snapshot = await a.snapshot();
    assert.equal(snapshot.projects.length,1);
    assert.equal(snapshot.projects[0].title,'Renamed');
    assert.equal(snapshot.projects[0].geometry.height,800);
    assert.deepEqual(snapshot.projects[0].settings,{gap:12});
    await assert.rejects(a.settings(first.id,{projectOpening:'tabs'}),/common-only/);
    await a.settings(first.id,{gap:undefined});
    const reopened = await WorkspaceStore.open({indexedDB,channel:false});
    assert.deepEqual((await reopened.snapshot()).projects[0].settings,{});
    assert.equal((await reopened.snapshot()).common.mode,'light');
    reopened.close();
  } finally { a.close();b.close(); }
});

test('the tab state starts empty, keeps the entries of two windows, removes on null and refuses another format', async () => {
  const indexedDB = new IDBFactory();
  const a = await WorkspaceStore.open({indexedDB,channel:false});
  const b = await WorkspaceStore.open({indexedDB,channel:false});
  try {
    assert.equal(await a.tabState(), null);
    const bytes = await a.tabStatePut('tab-a',{kept:true});
    await b.tabStatePut('tab-b',{label:'b'});
    assert.equal(bytes, JSON.stringify({format:1,tabs:{'tab-a':{kept:true}}}).length);
    assert.deepEqual(await a.tabState(), {format:1,tabs:{'tab-a':{kept:true},'tab-b':{label:'b'}}});
    await b.tabStatePut('tab-a',null);
    assert.deepEqual(await a.tabState(), {format:1,tabs:{'tab-b':{label:'b'}}});
    await assert.rejects(a.tabStatePut('',{kept:true}), {message:'tab state put requires a tab'});
    await new Promise((resolve, reject) => {
      const tx = a.database.transaction(['settings'],'readwrite');
      tx.objectStore('settings').put({format:2,tabs:{}},'tab-state');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    await assert.rejects(a.tabStatePut('tab-c',{kept:true}), {message:'tab-state: tab state format 2 is not 1'});
    assert.deepEqual(await b.tabState(), {format:2,tabs:{}});
  } finally { a.close();b.close(); }
});

test('the tab sessions start empty, keep one document per tab, list the tabs and remove on null', async () => {
  const indexedDB = new IDBFactory();
  const a = await WorkspaceStore.open({indexedDB,channel:false});
  try {
    assert.equal(await a.tabSession('tab-a'), null);
    assert.deepEqual(await a.tabSessions(), []);
    const bytes = await a.tabSessionPut('tab-b',{page:{session:'BBBB'}});
    await a.tabSessionPut('tab-a',{page:{session:'AAAA'}});
    assert.equal(bytes, JSON.stringify({format:1,regions:{page:{session:'BBBB'}}}).length);
    assert.deepEqual(await a.tabSession('tab-a'), {format:1,regions:{page:{session:'AAAA'}}});
    assert.deepEqual(await a.tabSessions(), ['tab-a','tab-b']);
    assert.equal(await a.tabSessionPut('tab-a',null), null);
    assert.equal(await a.tabSession('tab-a'), null);
    assert.deepEqual(await a.tabSessions(), ['tab-b']);
    await assert.rejects(a.tabSessionPut('',null), {message:'tab session requires a tab'});
  } finally { a.close(); }
});
