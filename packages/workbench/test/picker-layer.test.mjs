import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { fillPicker, pickerColumns, pickerGroups, pickerItems } from "../picker-layer.js";

// The picker layer draws a group title as an element that does not receive presses, and the index that is chosen counts only items (docs/spec/example-model.md).
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

// So that a window check can measure the x of the columns, the icon and name of a title and an item carry declared dom names, and the title is reported as groups of core.picker.
test("the icon and the name of a heading and of an item carry declared dom names and the headings are reported", () => {
  const { document } = new JSDOM("<div id=picker></div>").window;
  const el = document.getElementById("picker");
  fillPicker(el, "스페이스 앱 3개", [
    { heading: { id: "a", name: "카드 1", depth: 0, map: "" }, items: [{ key: "a:t1", name: "터미널", mark: ">", svg: "" }] },
    { heading: { id: "b", name: "카드 2", depth: 2, map: "" }, items: [{ key: "b:t2", name: "없는 플러그인", mark: "?", svg: "" }] },
  ], () => {});
  const exposed = (name) => [...el.querySelectorAll(`[data-expose="${name}"]`)].map((node) => node.textContent);
  assert.deepEqual(exposed("core.picker.group-name"), ["카드 1", "카드 2"]);
  assert.deepEqual(exposed("core.picker.item-name"), ["터미널", "없는 플러그인"]);
  assert.equal(el.querySelectorAll('svg[data-expose="core.picker.group-icon"]').length, 2);
  assert.equal(el.querySelectorAll('svg[data-expose="core.picker.item-icon"]').length, 2);
  assert.deepEqual(pickerGroups(el), [{ id: "a", name: "카드 1", depth: 0 }, { id: "b", name: "카드 2", depth: 2 }]);
});

// The main document hides the picker once the native view draws it, so the columns are measured while the layout is alive and
// reported in the status: the x of the icon and of the name of each heading and item, relative to the picker.
test("the columns of the headings and the items are measured relative to the picker", () => {
  const { document } = new JSDOM("<div id=picker></div>").window;
  const el = document.getElementById("picker");
  fillPicker(el, "스페이스 앱 2개", [
    { heading: { id: "a", name: "카드 1", depth: 0, map: "" }, items: [{ key: "a:t1", name: "터미널", mark: ">", svg: "" }] },
    { heading: { id: "b", name: "카드 2", depth: 1, map: "" }, items: [{ key: "b:t2", name: "브라우저", mark: ">", svg: "" }] },
  ], () => {});
  // A layout engine gives each element a box; the test gives boxes that follow the depth, so the check reads the rule of the
  // function (relative to the picker, icon before name) and not the layout of one engine.
  const depthOf = (node) => Number((node.closest(".picker__group, .picker__item")).style.getPropertyValue("--depth") || 0);
  const x = (node) => 100 + depthOf(node) * 12 + (node.matches("svg") ? 8 : 38);
  for (const node of el.querySelectorAll("[data-expose]")) {
    node.getBoundingClientRect = () => ({ x: x(node), y: 0, left: x(node), top: 0, width: 14, height: 14, right: x(node) + 14, bottom: 14 });
  }
  el.getBoundingClientRect = () => ({ x: 100, y: 0, left: 100, top: 0, width: 300, height: 200, right: 400, bottom: 200 });
  const columns = pickerColumns(el);
  assert.deepEqual(columns.groups, [{ icon: 8, name: 38 }, { icon: 20, name: 50 }]);
  assert.deepEqual(columns.items, [{ icon: 8, name: 38 }, { icon: 20, name: 50 }]);
});
