// Verifies that the Go repeat target passes the build tag, and does not count a run in which no test ran as a pass. The Rust repeat target is verified in rust-repeat.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

// Puts a fake executable named tool in front of PATH and runs the target. The fake writes the arguments it received to the args file and prints the output;
// an output given as {plain,json} is printed as json when the arguments hold -json and as plain otherwise.
// The Makefile puts $(HOME)/.cargo/bin at the very front of PATH, so HOME is changed to a temporary folder and the fake is also placed under it.
function repeat(t,tool,output,target){
 const directory=mkdtempSync(join(tmpdir(),'soksak-language-repeat-'));
 t.after(()=>rmSync(directory,{recursive:true}));
 const args=join(directory,'args');
 const bin=join(directory,'.cargo','bin');
 mkdirSync(bin,{recursive:true});
 writeFileSync(join(bin,tool),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2))+'\\n');\nconst output=${JSON.stringify(output)};\nprocess.stdout.write(typeof output==='string'?output:process.argv.includes('-json')?output.json:output.plain);\n`,{mode:0o755});
 const result=spawnSync('make',target,{cwd:resolve(import.meta.dirname,'../..'),env:{...process.env,HOME:directory,PATH:bin+':'+process.env.PATH},encoding:'utf8',timeout:20000});
 // default: when the fake did not run, it received no arguments.
 let calls=[];
 try{calls=readFileSync(args,'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch(error){if(error.code!=='ENOENT')throw error;}
 return {...result,calls};
}

// The events of go test -json (cmd/test2json) of a package with no test files and of a package whose test passed.
const noTestFiles=pkg=>({plain:`?   \t${pkg}\t[no test files]\n`,json:[
 {Action:'start',Package:pkg},{Action:'output',Package:pkg,Output:`?   \t${pkg}\t[no test files]\n`},{Action:'skip',Package:pkg,Elapsed:0}]});
const passed=(pkg,name)=>({plain:`ok  \t${pkg}\t0.1s\n`,json:[
 {Action:'start',Package:pkg},{Action:'run',Package:pkg,Test:name},{Action:'output',Package:pkg,Test:name,Output:`--- PASS: ${name} (0.00s)\n`},
 {Action:'pass',Package:pkg,Test:name,Elapsed:0},{Action:'output',Package:pkg,Output:`ok  \t${pkg}\t0.1s\n`},{Action:'pass',Package:pkg,Elapsed:0.1}]});
const goOutput=(...packages)=>({plain:packages.map(entry=>entry.plain).join(''),
 json:packages.flatMap(entry=>entry.json).map(event=>JSON.stringify({Time:'2026-10-18T00:00:00Z',...event})+'\n').join('')});

test('go repeat fails a package whose test files are not built',{timeout:30000},t=>{
 const result=repeat(t,'go',goOutput(noTestFiles('fixture/src')),['go-repeat','PACKAGE=./fixture/src','COUNT=1','TEST=TestProbe']);
 assert.notEqual(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/no test files/);
});

test('go repeat passes a run whose tested package passed while a support package has no test files',{timeout:30000},t=>{
 const result=repeat(t,'go',goOutput(noTestFiles('fixture/tests/support'),passed('fixture/tests','TestProbe')),['go-repeat','PACKAGE=./fixture/tests/...','COUNT=1','TEST=TestProbe']);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/1 of 1 runs pass/);
});

test('go repeat fails a run in which no test matched',{timeout:30000},t=>{
 const output=goOutput(noTestFiles('fixture/tests/support'),{plain:'ok  \tfixture/tests\t0.1s [no tests to run]\n',json:[
  {Action:'start',Package:'fixture/tests'},{Action:'output',Package:'fixture/tests',Output:'testing: warning: no tests to run\n'},
  {Action:'output',Package:'fixture/tests',Output:'ok  \tfixture/tests\t0.1s [no tests to run]\n'},{Action:'pass',Package:'fixture/tests',Elapsed:0.1}]});
 const result=repeat(t,'go',output,['go-repeat','PACKAGE=./fixture/tests/...','COUNT=1','TEST=TestMissing']);
 assert.notEqual(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/no test matching TestMissing/);
});

test('go repeat passes its build tags to go list and go test',{timeout:30000},t=>{
 const result=repeat(t,'go',goOutput(passed('fixture/src','TestProbe')),['go-repeat','PACKAGE=./fixture/src','COUNT=1','TEST=TestProbe','TAGS=diagnostics']);
 assert.equal(result.status,0,result.stdout+result.stderr);
 // The native library input is resolved with go list before the one go test run.
 assert.deepEqual(result.calls.map(call=>call[0]),['list','test'],JSON.stringify(result.calls));
 for(const call of result.calls)assert.ok(call.includes('-tags')&&call[call.indexOf('-tags')+1]==='diagnostics',JSON.stringify(call));
});

