import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {resolveSidebar} from "../sidebar-sets.js";

// 세트 선택을 담당하는 실제 판 함수를 실행하고 선언된 설정 경계를 제어한다.
const source = readFileSync(new URL("../plane.js", import.meta.url), "utf8");
const begin = source.indexOf("function standingSet(place) {");
const end = source.indexOf("\n}", begin);
assert.ok(begin >= 0 && end > begin);
const selection = source.slice(begin, end + 2);

test("fixed sidebar selection applies only the focused active plugin override", async () => {
  const {windowSidebarCards} = await import("../window-sidebars.js");
  const links=[{place:"left",plugin:null,set:"general"},{place:"window-left",plugin:"pane",set:"override"}];
  let focused="pane";
  const calls=[];
  const f={windowSidebarCards,pluginUnits:()=>[{id:"pane"},{id:"other"}],value:()=>links,focusedPlugin:()=>focused,
    linkedSet:(place,plugin)=>{calls.push([place,plugin]);return place==="left"?"general":"override";}};
  runInNewContext(selection,f);
  assert.equal(f.standingSet("left"),"override");
  focused="other";
  assert.equal(f.standingSet("left"),"general");
  assert.deepEqual(calls,[["window-left","pane"],["left",null]]);
});

test("a null link set is rejected instead of silently hiding the sidebar",()=>{
  assert.throws(()=>resolveSidebar([{place:'left',plugin:null,set:null}],[],'left',null),/set that is gone/);
});
