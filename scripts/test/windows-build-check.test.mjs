// Windows 컴파일 검사 대상의 결과와 hosts-check 연결을 대상의 소유 경계에서 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
test('the Windows build check compiles the Go host source in the default and diagnostics builds',{timeout:600000},()=>{
 const result=spawnSync('make',['windows-build-check'],{cwd:root,encoding:'utf8',timeout:590000});
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/PASS: wailsv3 host for windows\/arm64/);
 assert.match(result.stdout,/PASS: wailsv3 diagnostics host for windows\/arm64/);
});
test('hosts-check runs the Windows build check',{timeout:30000},()=>{
 const result=spawnSync('make',['-n','hosts-check'],{cwd:root,encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/GOOS=windows GOARCH=arm64 go vet \.\/src\/\.\.\./);
 assert.match(result.stdout,/GOOS=windows GOARCH=arm64 go vet -tags diagnostics \.\/src\/\.\.\./);
});
