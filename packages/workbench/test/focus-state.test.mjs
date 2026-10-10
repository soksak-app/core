import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { focusName, focusState } from "../focus-state.js";

// A surface module mounts inside a shadow root of the main document. The activeElement of the document and the target of a focus event
// appear as the shadow host, so the focus state must follow the shadow root to read the actual element and its surface.
test("focus inside a surface's shadow root is reported by its exposed name and surface", () => {
  const dom = new JSDOM('<main><div data-native-surface-id="tab-1"><div class="surface-module-host"></div></div>' +
    '<button data-expose="core.chrome.projects"></button></main>');
  const { document } = dom.window;
  const host = document.querySelector(".surface-module-host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div id="bar"><input data-expose="fixture.address"></div>';
  const input = shadow.querySelector("input");
  let seen = null;
  document.addEventListener("focusin", (event) => { seen = focusName(event); }, true);
  input.focus();
  assert.deepEqual(focusState(document), { name: "fixture.address", index: 0, surface: "tab-1" });
  assert.equal(seen, "fixture.address");
  document.querySelector("button").focus();
  assert.deepEqual(focusState(document), { name: "core.chrome.projects", index: 0, surface: null });
  assert.equal(seen, "core.chrome.projects");
  document.querySelector("button").blur();
  assert.equal(focusState(document), null);
});
