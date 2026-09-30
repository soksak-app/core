import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {mkdtempSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import test from 'node:test';

const script=new URL('../check-release.mjs',import.meta.url).pathname;
function check(args){
 const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:4000});
 assert.ifError(result.error);assert.equal(result.status,1,result.stdout+result.stderr);
 return result.stderr;
}
test('release CLI inspects the supplied bundles instead of default release paths',{timeout:5000},t=>{
 const root=mkdtempSync(join(tmpdir(),'soksak-release-paths-'));t.after(()=>rmdirSync(root));
 const wails=join(root,'isolated-wails.app'),tauri=join(root,'isolated-tauri.app');
 const stderr=check(['--wailsv3-bundle',wails,'--tauriv2-bundle',tauri]);
 assert.ok(stderr.includes(join(wails,'Contents/MacOS/soksak-wailsv3')+': missing'),stderr);
 assert.ok(stderr.includes(join(tauri,'Contents/MacOS/soksak-tauriv2')+': missing'),stderr);
});
for(const [name,args,message]of[
 ['missing paths',[],/required release bundle options/],
 ['unknown option',['--unknown'],/unknown release option/],
 ['missing value',['--wailsv3-bundle'],/requires a bundle path/],
 ['empty value',['--wailsv3-bundle',''],/requires a bundle path/],
 ['option as value',['--wailsv3-bundle','--tauriv2-bundle'],/requires a bundle path/],
 ['duplicate option',['--wailsv3-bundle','a','--wailsv3-bundle','b'],/duplicate release option/],
])test(`release CLI rejects ${name}`,{timeout:5000},()=>{
 assert.match(check(args),message);
});
