// 두 host 의 긴 요청이 다를 때 실패 메시지가 처음 달라지는 자리와 그 주변을 밝히는지 검사한다(F40).
import assert from "node:assert/strict";
import test from "node:test";
import { textDifference } from "../text-difference.mjs";

test("the first differing position and its surroundings are named", () => {
  const head = "x".repeat(200);
  assert.equal(textDifference(`${head}"h":562.39,"w":560`, `${head}"h":562.40,"w":560`),
    `first difference at character 208: …${"x".repeat(32)}"h":562.39,"w":560 instead of …${"x".repeat(32)}"h":562.40,"w":560`);
});

test("equal texts have no difference and a longer text names its extra part", () => {
  assert.equal(textDifference("same", "same"), null);
  assert.equal(textDifference("abc", "abcdef"), "first difference at character 3: …abc instead of …abcdef");
});
