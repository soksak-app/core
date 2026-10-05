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
 assert.match(result.stdout,/cargo check -q --manifest-path Cargo\.toml -p soksak-host-tauriv2 --target aarch64-pc-windows-gnullvm/);
 assert.match(result.stdout,/cargo check -q --manifest-path Cargo\.toml -p soksak-host-tauriv2 --features diagnostics --target aarch64-pc-windows-gnullvm/);
});
// LLVM_MINGW 가 컴파일러가 없는 폴더를 가리키면 검사는 그 경로를 적고 실패한다.
test('the Windows Rust build check names the missing Windows C compiler',{timeout:30000},()=>{
 const result=spawnSync('make',['windows-build-check-rust','LLVM_MINGW=/nonexistent/llvm-mingw'],{cwd:root,encoding:'utf8',timeout:20000});
 assert.notEqual(result.status,0,result.stdout+result.stderr);
 assert.match(result.stderr,/FAIL: windows-build-check-rust requires the Windows C compiler \/nonexistent\/llvm-mingw\/bin\/aarch64-w64-mingw32-clang, which is not installed/);
 assert.doesNotMatch(result.stdout,/START: tauriv2 host/);
});
