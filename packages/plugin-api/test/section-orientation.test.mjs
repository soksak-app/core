import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManifest } from '../index.js';
const manifest = module => ({id:'probe',name:'Probe',description:'Section fixture.',sections:[{id:'probe.view',name:'View',module}]});
test('a section declares one shared implementation or both orientation implementations',()=>{
 for(const module of ['ui/shared.js',{horizontal:'ui/horizontal.js',vertical:'ui/vertical.js'}]) {
  const value=manifest(module);
  assert.equal(validateManifest(value),value);
 }
});
test('orientation implementations reject missing modes, extra keys and invalid paths',()=>{
 for(const module of [{horizontal:'ui/h.js'},{vertical:'ui/v.js'},{horizontal:'ui/h.js',vertical:'ui/v.js',diagonal:'ui/d.js'},
  {horizontal:null,vertical:'ui/v.js'},{horizontal:'../h.js',vertical:'ui/v.js'},{horizontal:'ui/h.js',vertical:'/v.js'},
  {horizontal:'ui/h.js',vertical:'ui/v.css'},[],{}]) assert.throws(()=>validateManifest(manifest(module)),/section.*module/);
});
