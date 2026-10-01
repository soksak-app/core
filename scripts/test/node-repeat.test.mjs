// 반복 실행의 성공 출력과 실패 전파를 대상의 소유 경계에서 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
function repeat(t,mode){
 const directory=mkdtempSync(join(tmpdir(),'soksak-repeat-target-'));
 t.after(()=>rmSync(directory,{recursive:true}));
 writeFileSync(join(directory,'node'),`#!${process.execPath}\nconsole.log('START fixture: owning case');\nconsole.log('fixture elapsed=1ms');\nconsole.log(${JSON.stringify(mode==='success'?'ok 1 - owning case':mode==='empty'?'ok 1 - fixture.test.mjs':'not ok 1 - owning case')});\nconsole.log('END fixture: owning case');\nprocess.exit(${mode==='failure'?17:0});\n`,{mode:0o755});
 return spawnSync('make',['node-repeat','FILE=fixture.test.mjs','NAME=owning case','COUNT=2'],{
  cwd:resolve(import.meta.dirname,'../..'),env:{...process.env,PATH:directory+':'+process.env.PATH},encoding:'utf8',timeout:10000});
}
test('node repeat preserves successful case progress for every run',{timeout:15000},t=>{
 const result=repeat(t,'success');assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.split('START fixture: owning case').length-1,2,'successful run start output was discarded');
 assert.equal(result.stdout.split('fixture elapsed=1ms').length-1,2,'successful run elapsed output was discarded');
 assert.equal(result.stdout.split('END fixture: owning case').length-1,2,'successful run result output was discarded');
});
test('node repeat preserves child failure and stops before another run',{timeout:15000},t=>{
 const result=repeat(t,'failure');assert.notEqual(result.status,0);
 assert.match(result.stdout,/END fixture: owning case/);assert.match(result.stderr,/run 1 of 2/);
 assert.equal(result.stdout.split('START fixture: owning case').length-1,1);
});
test('node repeat rejects a run without a matching passed case',{timeout:15000},t=>{
 const result=repeat(t,'empty');assert.notEqual(result.status,0);assert.match(result.stderr,/no test .* matched/);
});

// 실제 node 실행기의 출력으로 센다. 이 검사의 node:test 실행 문맥(NODE_TEST_CONTEXT)은 넘기지 않는다.
const {NODE_TEST_CONTEXT,...environment}=process.env;
function repeatReal(t,name,color){
 const directory=mkdtempSync(join(tmpdir(),'soksak-repeat-real-'));
 t.after(()=>rmSync(directory,{recursive:true}));
 const file=join(directory,'probe.test.mjs');
 writeFileSync(file,'import test from "node:test";\ntest("probe passes", () => {});\n');
 return spawnSync('make',['node-repeat',`FILE=${file}`,`NAME=${name}`,'COUNT=2'],{
  cwd:resolve(import.meta.dirname,'../..'),env:{...environment,FORCE_COLOR:color},encoding:'utf8',timeout:20000});
}
test('node repeat counts passing runs when the reporter writes colors',{timeout:30000},t=>{
 const result=repeatReal(t,'probe passes','3');
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/2 of 2 runs pass/);
});
for(const color of ['3','0'])test(`node repeat rejects a name pattern that runs no test with FORCE_COLOR=${color}`,{timeout:30000},t=>{
 const result=repeatReal(t,'missing probe',color);
 assert.notEqual(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/no test .* matched/);
});
