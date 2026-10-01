import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { focusName, focusState } from "../focus-state.js";

// 표면 모듈은 메인 문서의 shadow root 안에 마운트된다. 문서의 activeElement 와 focus 사건의 target 은 shadow host 로
// 바뀌어 보이므로, 초점 상태는 shadow root 를 따라가 실제 요소와 그 표면을 읽어야 한다.
test("focus inside a surface's shadow root is reported by its exposed name and surface", () => {
  const dom = new JSDOM('<main><div data-native-surface-id="tab-1"><div class="surface-module-host"></div></div>' +
    '<button data-expose="core.chrome.projects"></button></main>');
  const { document } = dom.window;
  const host = document.querySelector(".surface-module-host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div id="bar"><input data-expose="browser.address"></div>';
  const input = shadow.querySelector("input");
  let seen = null;
  document.addEventListener("focusin", (event) => { seen = focusName(event); }, true);
  input.focus();
  assert.deepEqual(focusState(document), { name: "browser.address", index: 0, surface: "tab-1" });
  assert.equal(seen, "browser.address");
  document.querySelector("button").focus();
  assert.deepEqual(focusState(document), { name: "core.chrome.projects", index: 0, surface: null });
  assert.equal(seen, "core.chrome.projects");
  document.querySelector("button").blur();
  assert.equal(focusState(document), null);
});
