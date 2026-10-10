// Measures the color of the rail boundary line in a recorded frame or a still capture.
import assert from "node:assert/strict";
import { pixel } from "@soksak/window-check/frame.mjs";

/**
 * For every loop of core.rail, finds the rail color (--rail of the dark midnight theme) at 1/4 and 3/4 of one vertical side. The middle of a side
 * is not measured, because the handle of the boundary line between two cards can cover it.
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
