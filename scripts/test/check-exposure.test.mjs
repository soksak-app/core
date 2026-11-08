import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {auditDeclarationCopies, auditWorkbenchNames, auditWorkbenchRegistrations, DECLARATION_COPIES} from '../check-exposure.mjs';

test('exposure audit checks published shared and orientation-specific section implementations',{timeout:10000},()=>{
 const output=execFileSync(process.execPath,[new URL('../check-exposure.mjs',import.meta.url).pathname],{encoding:'utf8',stdio:'pipe'});
 assert.match(output,/Exposure checks passed: core/);
});

test('each language host library and the mygo workbench hold their copies of the declarations',{timeout:1000},()=>{
 assert.deepEqual(DECLARATION_COPIES,[
  {source:'packages/workbench/workbench.json',copy:'packages/host/go/src/workbench.json'},
  {source:'packages/workbench/workbench.json',copy:'packages/host/rust/src/workbench.json'},
  {source:'packages/workbench/exposure.json',copy:'packages/workbench-mygo/src/exposure.json'},
  {source:'packages/workbench/shortcuts.json',copy:'packages/workbench-mygo/src/shortcuts.json'},
  {source:'packages/workbench/workbench.json',copy:'packages/workbench-mygo/src/workbench.json'},
  {source:'packages/plugin-api/contract/contributions.json',copy:'packages/workbench-mygo/tests/testdata/contributions.json'},
 ]);
});

for(const name of ['exposure.json','shortcuts.json','workbench.json']){
 test(`a copy of ${name} in the mygo workbench that differs from its source fails`,{timeout:1000},()=>{
  const copy=DECLARATION_COPIES.find((entry)=>entry.copy===`packages/workbench-mygo/src/${name}`);
  assert.ok(copy,`${name} has no copy in the mygo workbench`);
  const files={[copy.source]:'{"a":1}',[copy.copy]:'{"a":2}'};
  assert.deepEqual(auditDeclarationCopies([copy],(path)=>files[path]),[
   `${copy.copy} differs from ${copy.source}; run node scripts/check-exposure.mjs --write`,
  ]);
 });
}

test('a copy of workbench.json in a language host library that differs from its source fails',{timeout:1000},()=>{
 const files={'declaration/workbench.json':'{"a":1}\n','go/workbench.json':'{"a":1}\n','rust/workbench.json':'{"a":2}\n'};
 const copies=[
  {source:'declaration/workbench.json',copy:'go/workbench.json'},
  {source:'declaration/workbench.json',copy:'rust/workbench.json'},
 ];
 assert.deepEqual(auditDeclarationCopies(copies,(path)=>files[path]),[
  'rust/workbench.json differs from declaration/workbench.json; run node scripts/check-exposure.mjs --write',
 ]);
});

const declared={status:[{name:'core.layout'}],commands:[{name:'core.space.add'}],element:[{name:'core.chrome.left'}]};
const goSource=(text)=>[{path:'packages/workbench-mygo/src/fixture.go',text}];

test('a Go source of the mygo workbench that registers an undeclared status fails',{timeout:1000},()=>{
 assert.deepEqual(auditWorkbenchNames(declared,goSource('r.Status("core.absent", read)')),[
  'packages/workbench-mygo/src/fixture.go:1: status core.absent is not declared',
 ]);
});

test('a Go source of the mygo workbench that passes a name of another kind fails',{timeout:1000},()=>{
 assert.deepEqual(auditWorkbenchNames(declared,goSource('r.Command("core.layout", run)\nb.Press(c, "core.space.add", "core.layout", "", nil)')),[
  'packages/workbench-mygo/src/fixture.go:1: command core.layout is not declared',
  'packages/workbench-mygo/src/fixture.go:2: element name core.space.add is not declared',
  'packages/workbench-mygo/src/fixture.go:2: command core.layout is not declared',
 ]);
});

test('the Go sources of the mygo workbench pass names that are declared',{timeout:1000},()=>{
 assert.deepEqual(auditWorkbenchNames(declared,goSource('r.Status("core.layout", read)\nr.Command("core.space.add", run)\nb.Control(c, "core.chrome.left", "core.space.add", "")')),[]);
});

const registered={status:[{name:'core.layout'}],commands:[{name:'core.space.add'}],element:[]};

test('a Go source of the mygo workbench that does not register a declared status or command fails',{timeout:1000},()=>{
 assert.deepEqual(auditWorkbenchRegistrations(registered,goSource('b.Press(c, "core.chrome.left", "core.space.add", "", nil)\nread("core.layout")')),[
  'status core.layout is declared and no Go source of the mygo workbench registers it',
  'command core.space.add is declared and no Go source of the mygo workbench registers it',
 ]);
});

test('each registration of a Go source of the mygo workbench counts for its kind',{timeout:1000},()=>{
 assert.deepEqual(auditWorkbenchRegistrations(registered,goSource('r.Status("core.layout", read)\nr.Command("core.space.add", run)')),[]);
 for(const call of ['r.CommandLater("core.space.add", run)','command(s, "core.space.add", run)','later(s, "core.space.add", run)','act(s, "core.space.add", run)','laterAct(s, "core.space.add", run)','laterCommand(s, "core.space.add", run)','windowAct(s, "core.space.add", run)','sectionCommand(s, "core.space.add", run)','change("core.space.add", run)','act[T](s, "core.space.add", run)']){
  assert.deepEqual(auditWorkbenchRegistrations(registered,goSource(`r.Status("core.layout", read)\n${call}`)),[],call);
 }
 assert.deepEqual(auditWorkbenchRegistrations(registered,goSource('r.Command("core.layout", run)\nr.Status("core.space.add", read)')),[
  'status core.layout is declared and no Go source of the mygo workbench registers it',
  'command core.space.add is declared and no Go source of the mygo workbench registers it',
 ],'a registration of the other kind does not count');
});

test('the entries that the view bridge registers count as registered',{timeout:1000},()=>{
 const bridge='expose.status("core.layout", read);\nexpose.command("core.space.add", hit);';
 assert.deepEqual(auditWorkbenchRegistrations(registered,goSource(''),[bridge]),[]);
});
