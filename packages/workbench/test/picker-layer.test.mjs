import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { fillPicker, pickerItems } from "../picker-layer.js";

// 선택 레이어는 묶음 제목을 누름을 받지 않는 요소로 그리고, 고르는 index 는 항목만 센다(docs/spec/example-model.md).
test("a grouped picker draws headings that take no press and counts only the items", () => {
  const { document } = new JSDOM("<div id=picker></div>").window;
  const el = document.getElementById("picker");
  const marked = [];
  const keys = fillPicker(el, "스페이스 앱 3개", [
    { heading: { id: "a", name: "카드 1", depth: 0, map: '<rect x="0" y="0" width="5" height="10"/>' },
      items: [{ key: "a:t1", name: "터미널", mark: ">", svg: "", active: true }] },
    { heading: { id: "b", name: "카드 2", depth: 1, map: "" },
      items: [{ key: "b:t2", name: "브라우저", mark: "B", svg: "" }, { key: "b:t3", name: "파일", mark: "F", svg: "" }] },
  ], (button, index) => marked.push([button.dataset.key, index]));
  assert.deepEqual(keys, ["a:t1", "b:t2", "b:t3"]);
  assert.deepEqual(marked, [["a:t1", 0], ["b:t2", 1], ["b:t3", 2]]);
  const headings = [...el.querySelectorAll(".picker__group")];
  assert.deepEqual(headings.map((h) => [h.dataset.group, h.dataset.key, h.style.getPropertyValue("--depth"), h.textContent]),
    [["a", undefined, "0", "카드 1"], ["b", undefined, "1", "카드 2"]]);
  assert.equal(headings[0].querySelector("svg").innerHTML, '<rect x="0" y="0" width="5" height="10"></rect>');
  assert.deepEqual(pickerItems(el), [
    { key: "a:t1", name: "터미널", active: true, group: "a" },
    { key: "b:t2", name: "브라우저", active: false, group: "b" },
    { key: "b:t3", name: "파일", active: false, group: "b" },
  ]);
});

test("an ungrouped picker draws its items with no heading and no group", () => {
  const { document } = new JSDOM("<div id=picker></div>").window;
  const el = document.getElementById("picker");
  const keys = fillPicker(el, "탭 1개", [{ heading: null, items: [{ key: "t1", name: "터미널", mark: ">", svg: "" }] }], () => {});
  assert.deepEqual(keys, ["t1"]);
  assert.equal(el.querySelectorAll(".picker__group").length, 0);
  assert.equal(el.querySelector(".picker__head").textContent, "탭 1개");
  assert.deepEqual(pickerItems(el), [{ key: "t1", name: "터미널", active: false, group: null }]);
});
