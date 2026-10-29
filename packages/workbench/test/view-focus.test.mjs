// core.focus reports the focused exposed element of the document that holds the first responder of the window: the main page reads its
// own element, a view surface the element that its view reported with tab.focus, and every other owner has none
// (docs/spec/exposure.md#keyboard-focus).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { answerViewCall } from "../view-calls.js";
import { focusState } from "../focus-state.js";

const call = (surface, params) => answerViewCall({ id: 1, command: "tab.focus", params },
  { plugin: "fixture-view", surface, pending: new Map(), tab: null });

test("core.focus follows the first responder to the element that a view reports", { timeout: 5000 }, async () => {
  const { document } = new JSDOM('<main><button data-expose="core.chrome.projects"></button></main>').window;
  document.querySelector("button").focus();
  assert.equal(await call("tab-view", { name: "fixture.address", index: 0 }), null, "the page refused the focus report of a view");
  const { setResponder, forgetViewFocus } = await import("../view-focus.js");
  assert.deepEqual(focusState(document), { name: "core.chrome.projects", index: 0, surface: null },
    "the main page lost its focus before a first responder event");
  setResponder({ owner: "surface", surface: "tab-view", document: null });
  assert.deepEqual(focusState(document), { name: "fixture.address", index: 0, surface: "tab-view" },
    "core.focus did not report the focused element of the view that holds the first responder");
  assert.equal(await call("tab-view", null), null);
  assert.equal(focusState(document), null, "a view without a focused exposed element still reported one");
  setResponder({ owner: "page", surface: null, document: null });
  assert.deepEqual(focusState(document), { name: "core.chrome.projects", index: 0, surface: null });
  for (const owner of ["document", "native", "modal", "webview"]) {
    setResponder({ owner, surface: owner === "document" ? "tab-view" : null, document: owner === "document" ? "page" : null });
    assert.equal(focusState(document), null, `core.focus reported an element while the ${owner} holds the first responder`);
  }
  await call("tab-view", { name: "fixture.address", index: 0 });
  setResponder({ owner: "surface", surface: "tab-view", document: null });
  forgetViewFocus("tab-view");
  assert.equal(focusState(document), null, "the focus of an ended view document remained");
  setResponder({ owner: "page", surface: null, document: null });
});

test("a malformed focus report or first responder event is refused", { timeout: 5000 }, async () => {
  const { setResponder } = await import("../view-focus.js");
  await assert.rejects(call("tab-view", { name: "fixture.address" }), /view call tab.focus requires \{name, index\} or null, not \{"name":"fixture.address"\}/);
  await assert.rejects(call("tab-view", "fixture.address"), /view call tab.focus requires \{name, index\} or null/);
  assert.throws(() => setResponder({ owner: "surface", surface: 5, document: null }), /invalid window-responder event \{"owner":"surface","surface":5,"document":null\}/);
  assert.throws(() => setResponder(null), /invalid window-responder event null/);
});
