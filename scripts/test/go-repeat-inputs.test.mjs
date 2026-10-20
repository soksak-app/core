// Verifies that the repeat target of Go tests passes the native library only to the packages that link it, and that a package
// which links a library that is not built fails by the name of the library.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'../..');
const library=resolve(root,'native/darwin/build/libsoksak-darwin.a');
const resolveInputs=(pkg,tags)=>spawnSync('node',['scripts/go-repeat-inputs.mjs',pkg,...(tags?[tags]:[])],{cwd:root,encoding:'utf8',timeout:60000});

test('go repeat does not name the native library for a package that does not link it',{timeout:30000},()=>{
 const result=spawnSync('make',['-n','go-repeat','PACKAGE=./packages/sok/wailsv3/tests','COUNT=1','TEST=TestPluginPack'],{cwd:root,encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.doesNotMatch(result.stdout,/libsoksak-darwin\.a/,'the recipe computes the native library for a package without cgo');
});

test('go repeat resolves no native library input for a package that does not link it',{timeout:90000},()=>{
 const result=resolveInputs('./packages/sok/wailsv3/tests');
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.equal(result.stdout,'','a package without the library gets a library define');
 assert.equal(result.stderr,'','a package without the library prints a warning');
});

test('go repeat names the native library for a package that links it',{timeout:90000},()=>{
 const result=resolveInputs('./packages/host/wailsv3/tests');
 if(existsSync(library)){
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/^-DSOKSAK_DARWIN_LIBRARY=[0-9a-f]{16}\n$/);
 }else{
  // A package that needs the library fails by the path of the library when the library is not built.
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/native\/darwin\/build\/libsoksak-darwin\.a/);
 }
});
