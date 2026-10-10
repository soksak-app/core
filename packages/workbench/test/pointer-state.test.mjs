import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { trackPointer } from "../pointer-state.js";

// If the pressed element is replaced between a press and a release, the browser creates no click. The test records the pointer order that the document received and whether the pressed element
// was still in the document at the release, to identify the reason for a lost click.
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
