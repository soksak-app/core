// Go 와 Rust 반복 실행 대상이 build tag 와 feature 를 넘기고, 실행된 테스트가 없는 실행을 통과로 세지 않는지 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

// tool 이라는 이름의 가짜 실행 파일을 PATH 앞에 두고 대상을 실행한다. 가짜는 받은 인자를 args 파일에 쓰고 output 을 출력한다.
// Makefile 은 $(HOME)/.cargo/bin 을 PATH 맨 앞에 두므로 HOME 을 임시 폴더로 바꾸고 가짜를 그 아래에도 둔다.
function repeat(t,tool,output,target){
 const directory=mkdtempSync(join(tmpdir(),'soksak-language-repeat-'));
 t.after(()=>rmSync(directory,{recursive:true}));
 const args=join(directory,'args');
 const bin=join(directory,'.cargo','bin');
 mkdirSync(bin,{recursive:true});
 writeFileSync(join(bin,tool),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.stdout.write(${JSON.stringify(output)});\n`,{mode:0o755});
 const result=spawnSync('make',target,{cwd:resolve(import.meta.dirname,'../..'),env:{...process.env,HOME:directory,PATH:bin+':'+process.env.PATH},encoding:'utf8',timeout:20000});
 // 기본값: 가짜가 실행되지 않았으면 받은 인자가 없다.
 let calls=[];
 try{calls=readFileSync(args,'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch(error){if(error.code!=='ENOENT')throw error;}
 return {...result,calls};
}

test('go repeat fails a package whose test files are not built',{timeout:30000},t=>{
 const result=repeat(t,'go','?   \tfixture/src\t[no test files]\n',['go-repeat','PACKAGE=./fixture/src','COUNT=1','TEST=TestProbe']);
 assert.notEqual(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/no test files/);
});

test('go repeat passes its build tags to go test',{timeout:30000},t=>{
 const result=repeat(t,'go','ok  \tfixture/src\t0.1s\n',['go-repeat','PACKAGE=./fixture/src','COUNT=1','TEST=TestProbe','TAGS=diagnostics']);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.ok(result.calls.length===1&&result.calls[0].includes('-tags')&&result.calls[0][result.calls[0].indexOf('-tags')+1]==='diagnostics',JSON.stringify(result.calls));
});

test('rust repeat passes its features to every cargo test',{timeout:30000},t=>{
 const result=repeat(t,'cargo','running 1 test\ntest probe ... ok\n\ntest result: ok. 1 passed; 0 failed\n',['rust-repeat','PACKAGE=fixture','COUNT=1','TEST=probe','FEATURES=diagnostics']);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.equal(result.calls.length,2,JSON.stringify(result.calls));
 for(const call of result.calls)assert.ok(call.includes('--features')&&call[call.indexOf('--features')+1]==='diagnostics',JSON.stringify(call));
});
