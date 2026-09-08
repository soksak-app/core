import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { WorkspaceStore } from '../browser/browser-storage.js';
import { effectiveSettings } from '../browser/settings-scope.js';

test('project values override common values and opening mode remains common-only', () => {
  const defaults = { gap:6, mode:'dark', projectOpening:'windows', links:[] };
  const common = { gap:8, mode:'light', projectOpening:'tabs' };
  const overrides = { gap:12, projectOpening:'windows' };
  assert.deepEqual(effectiveSettings(defaults,common,overrides), {gap:12,mode:'light',projectOpening:'tabs',links:[]});
  delete overrides.gap;
  assert.equal(effectiveSettings(defaults,common,overrides).gap,8);
  assert.equal(effectiveSettings(defaults,{},{}).projectOpening,'windows');
});

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
