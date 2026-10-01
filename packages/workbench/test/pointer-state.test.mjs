import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { trackPointer } from "../pointer-state.js";

// 누름과 뗌 사이에 누른 요소가 교체되면 브라우저는 click 을 만들지 않는다. 문서가 받은 pointer 순서와 누른 요소가
// 뗄 때 문서에 남아 있었는지를 기록해 사라진 click 의 까닭을 가린다.
test("the last pointer sequence names its targets and whether the pressed element survived", () => {
  const dom = new JSDOM('<button data-expose="core.chrome.projects">p</button>');
  const { document, PointerEvent, MouseEvent } = dom.window;
  let changes = 0;
  const state = trackPointer(document, () => changes++);
  const button = document.querySelector("button");
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true }));
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  assert.deepEqual(state(), { sequence: 1, down: "core.chrome.projects", up: "core.chrome.projects",
    pressedConnected: true, click: "core.chrome.projects" });
  assert.equal(changes, 3);
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  const replacement = button.cloneNode(true);
  button.replaceWith(replacement);
  replacement.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true }));
  assert.deepEqual(state(), { sequence: 2, down: "core.chrome.projects", up: "core.chrome.projects",
    pressedConnected: false, click: null });
});
