// 모달 문서의 내용 갱신은 바뀌지 않은 조작 요소를 문서에 둔다(docs/spec/exposure.md). 누름과 뗌 사이의 갱신이 눌린
// 요소를 문서에서 빼면 WebKit 은 click 을 보내지 않는다(F66.2).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { updateContent } from "../overlay-content.js";

const html = (title, checked) => `<header class="head"><h2>${title}</h2></header>` +
  `<section data-scroll-key="general"><button type="button" data-command="core.settings.section" data-params='{"section":"general"}'>일반</button>` +
  `<label><input type="checkbox" data-command="core.settings.change"${checked ? " checked" : ""}> 사용</label></section>`;

test("an update keeps the controls of the dialog in the document and applies the changed values", () => {
  const dom = new JSDOM("<body><div id=root></div></body>");
  const root = dom.window.document.getElementById("root");
  updateContent(root, html("설정", false));
  const button = root.querySelector("button");
  const box = root.querySelector("input");
  updateContent(root, html("환경설정", true));
  assert.ok(button.isConnected, "an update took the button out of the document");
  assert.ok(box.isConnected, "an update took the checkbox out of the document");
  assert.equal(root.querySelector("h2").textContent, "환경설정");
  assert.equal(box.checked, true, "the update did not apply the new checked state");
  const reference = dom.window.document.createElement("div");
  reference.innerHTML = html("환경설정", true);
  assert.equal(root.innerHTML, reference.innerHTML, "the updated dialog differs from the sent content");
  dom.window.close();
});

test("an update replaces an element whose kind or command changed", () => {
  const dom = new JSDOM("<body><div id=root></div></body>");
  const root = dom.window.document.getElementById("root");
  updateContent(root, `<button data-command="a">A</button><p>x</p>`);
  const first = root.querySelector("button");
  updateContent(root, `<button data-command="b">B</button><span>y</span>`);
  assert.equal(first.isConnected, false, "a control bound to another command kept its node");
  assert.equal(root.innerHTML, `<button data-command="b">B</button><span>y</span>`);
  dom.window.close();
});
