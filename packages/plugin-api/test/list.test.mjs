// drawList 는 key 가 같은 요소를 문서에 둔 채 갱신한다. 누름과 뗌 사이에 눌린 요소가 문서에서 빠지면 WebKit 은
// click 을 보내지 않는다(core docs/spec/exposure.md, F67).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { drawList } from "../index.js";

const draw = (list, entries) => drawList(list, entries, {
  key: (entry) => entry.id,
  create: () => { const item = list.ownerDocument.createElement("li"); item.append(list.ownerDocument.createElement("button")); return item; },
  update: (item, entry) => { item.firstChild.textContent = entry.title; },
});

test("drawList keeps the element of each unchanged key and updates it", () => {
  const dom = new JSDOM("<ul></ul>");
  const list = dom.window.document.querySelector("ul");
  draw(list, [{ id: "a", title: "A" }, { id: "b", title: "B" }]);
  const [a, b] = list.children;
  draw(list, [{ id: "a", title: "A2" }, { id: "b", title: "B" }]);
  assert.equal(list.children[0], a);
  assert.equal(list.children[1], b);
  assert.equal(a.textContent, "A2");
  dom.window.close();
});

test("drawList builds new keys, removes missing keys and moves only elements out of order", () => {
  const dom = new JSDOM("<ul></ul>");
  const list = dom.window.document.querySelector("ul");
  draw(list, [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }]);
  const [a, , c] = list.children;
  const removed = [];
  new dom.window.MutationObserver(() => {}).observe(list, { childList: true });
  const watch = new dom.window.MutationObserver((records) => {
    for (const record of records) for (const node of record.removedNodes) removed.push(node.textContent);
  });
  watch.observe(list, { childList: true });
  draw(list, [{ id: "a", title: "A" }, { id: "c", title: "C" }, { id: "d", title: "D" }]);
  for (const record of watch.takeRecords()) for (const node of record.removedNodes) removed.push(node.textContent);
  assert.deepEqual([...list.children].map((item) => item.textContent), ["A", "C", "D"]);
  assert.equal(list.children[0], a);
  assert.equal(list.children[1], c);
  assert.deepEqual(removed, ["B"], "drawList moved an element that was already in order");
  dom.window.close();
});

test("drawList refuses two entries with the same key", () => {
  const dom = new JSDOM("<ul></ul>");
  const list = dom.window.document.querySelector("ul");
  assert.throws(() => draw(list, [{ id: "a", title: "A" }, { id: "a", title: "B" }]), /drawList: key "a" appears twice/);
  dom.window.close();
});

test("drawList removes text that is not an element of the list", () => {
  const dom = new JSDOM("<ul>없음</ul>");
  const list = dom.window.document.querySelector("ul");
  draw(list, [{ id: "a", title: "A" }]);
  assert.deepEqual([...list.childNodes].map((node) => node.textContent), ["A"]);
  dom.window.close();
});
