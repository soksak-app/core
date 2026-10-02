import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

test('exposure audit checks published shared and orientation-specific section implementations',{timeout:10000},()=>{
 const output=execFileSync(process.execPath,[new URL('../check-exposure.mjs',import.meta.url).pathname],{encoding:'utf8',stdio:'pipe'});
 assert.match(output,/Exposure checks passed: core/);
});
