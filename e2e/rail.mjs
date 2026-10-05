// 녹화 프레임이나 정지 캡처에서 레일 경계선의 색을 잰다.
import assert from "node:assert/strict";
import { pixel } from "@soksak/window-check/frame.mjs";

/**
 * core.rail 의 모든 고리마다 세로 변 하나의 1/4 과 3/4 지점에서 레일 색(midnight 어두운 테마 --rail)을 찾는다. 변의
 * 가운데는 두 카드 사이 경계선의 손잡이가 덮을 수 있으므로 재지 않는다.
 */
export function railPixels(frame,grid,rail){
 const scale=frame.scale*frame.contentScale;
 for(const group of rail.groups)for(const loop of group.loops){
  const pair=loop.map((a,index)=>[a,loop[(index+1)%loop.length]])
   .find(([a,b])=>a.x===b.x&&Math.abs(a.y-b.y)>64);
  assert.ok(pair,'rail outline has no measurable vertical segment');
  const [a,b]=pair;
  for(const share of [0.25,0.75]) assert.ok([-1,-0.5,0,0.5,1].some(offset=>{
   const x=Math.floor(frame.content.x*frame.scale+(grid.plane.x+a.x+offset)*scale);
   const y=Math.floor(frame.content.y*frame.scale+(grid.plane.y+a.y+(b.y-a.y)*share)*scale);
   return pixel(frame,x,y).every((value,index)=>Math.abs(value-[114,121,255][index])<=5);
  }),`rail border for ${group.card} is absent at ${share} of its edge x=${a.x} at ${frame.time}ms`);
 }
}
