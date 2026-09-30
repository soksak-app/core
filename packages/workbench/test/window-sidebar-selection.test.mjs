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

test("general window sidebar selection does not read the focused plugin", () => {
  let reads = 0;
  const calls = [];
  const general = { id: "general" };
  const f = { railKind: () => null, focusedPlugin: () => { reads++; return "pane"; },
    linkedSet: (place, plugin) => { calls.push([place, plugin]); return plugin === null ? general : { id: "focused" }; },
    windowSidebar: () => ({ side: "left", plugin: null }) };
  runInNewContext(selection, f);
  assert.equal(f.standingSet("left"), general);
  assert.equal(reads, 0);
  assert.deepEqual(calls, [["left", null]]);
});

test("a null link set is rejected instead of silently hiding the sidebar",()=>{
  assert.throws(()=>resolveSidebar([{place:'left',plugin:null,set:null}],[],'left',null),/set that is gone/);
});
