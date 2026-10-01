// 관측 PNG의 투명도와 좌표 경계를 검증한다. 창을 실행하거나 활성화하지 않는다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {readPng} from '../png.mjs';
function chunk(type,body){
 const bytes=Buffer.concat([Buffer.from(type),body]);let crc=0xffffffff;
 for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 const result=Buffer.alloc(body.length+12);result.writeUInt32BE(body.length);bytes.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
}
function fixture(t,raw=Buffer.from([0,255,0,0,255,0,255,0,0])){
 const directory=mkdtempSync(join(tmpdir(),'soksak-png-contract-'));t.after(()=>rmSync(directory,{recursive:true}));
 const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 const path=join(directory,'capture.png');
 writeFileSync(path,Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
 return readPng(path);
}
test('capture PNG exposes opacity independently of stored RGB',t=>{
 const image=fixture(t);assert.deepEqual(image.pixel(0,0),[255,0,0]);assert.deepEqual(image.pixel(1,0),[0,255,0]);
 assert.equal(image.alpha(0,0),255);assert.equal(image.alpha(1,0),0);
});
test('capture PNG rejects out-of-range and fractional coordinates',t=>{
 const image=fixture(t);
 for(const [x,y] of [[-1,0],[2,0],[0,-1],[0,1],[0.5,0],[NaN,0]])assert.throws(()=>image.pixel(x,y),/pixel coordinates/);
});
test('capture PNG rejects incomplete decoded pixels instead of producing zero values',t=>{
 assert.throws(()=>fixture(t,Buffer.from([0,255,0,0,255])),/decoded bytes/);
});
