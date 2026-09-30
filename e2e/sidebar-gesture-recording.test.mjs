// 제어된 프레임으로 경계 거부와 진단 출처를 검증한다. 실제 렌더링 실패 원인을 대신하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedEdges} from './sidebar-gesture-recording.mjs';
function frame(time,border){
 const data=Buffer.alloc(100*100*4);
 for(let y=0;y<100;y++)for(let x=0;x<100;x++){
  const color=y===border?[43,46,61]:[25,27,36],at=(y*100+x)*4;
  data.set([color[2],color[1],color[0],255],at);
 }
 return {time,width:100,height:100,stride:400,content:{x:0,y:0,width:100,height:100},scale:1,contentScale:1,data};
}
test('gesture recording retains the existing strict border predicate',()=>{
 const result=recordedEdges([frame(1,50),frame(2,60)],'top',50,50,[],[]);
 assert.ok(result[0].includes(50));assert.ok(result[1].includes(60));
});
test('missing gesture frame reports index poses and full-axis border evidence',()=>{
 const poses=[{displayed:1,size:120,applied:{x:0,y:51,w:100,h:20}}];
 const layouts=[{ticket:7,begun:0.5,presented:1,committed:1.5}];
 let failure;try{recordedEdges([frame(1,50),frame(2,-1)],'top',50,50,poses,layouts);}catch(error){failure=error;}
 assert.ok(failure,'a missing border was silently accepted');
 const details=JSON.parse(failure.message.slice(failure.message.indexOf('{')));
 assert.equal(details.frameIndex,1);assert.equal(details.frameCount,2);assert.equal(details.time,2);
 assert.deepEqual(details.poses,poses);assert.deepEqual(details.layouts,layouts);assert.deepEqual(details.axisBorders,[]);
 assert.ok(details.samples.every(sample=>sample.colors.every(color=>color.join(',')==='25,27,36')));
});
