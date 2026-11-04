import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {auditDeclarationCopies, DECLARATION_COPIES} from '../check-exposure.mjs';

test('exposure audit checks published shared and orientation-specific section implementations',{timeout:10000},()=>{
 const output=execFileSync(process.execPath,[new URL('../check-exposure.mjs',import.meta.url).pathname],{encoding:'utf8',stdio:'pipe'});
 assert.match(output,/Exposure checks passed: core/);
});

test('each language host library holds a copy of workbench.json',{timeout:1000},()=>{
 assert.deepEqual(DECLARATION_COPIES,[
  {source:'packages/workbench/workbench.json',copy:'packages/host/go/src/workbench.json'},
  {source:'packages/workbench/workbench.json',copy:'packages/host/rust/src/workbench.json'},
 ]);
});

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
