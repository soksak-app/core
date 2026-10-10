// Verifies the result of the Windows compile check target and its connection to hosts-check at the ownership boundary of the target.
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
