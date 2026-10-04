// 화면에 보인 오류가 그 순간 애플리케이션 로그에 남는지 검사한다.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const lines = [];
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => { if (name === "report") lines.push(payload); },
} } });
const { JSDOM } = await import("jsdom");
const { document } = new JSDOM("<p></p>").window;
const { hideError, showError } = await import("../shown-errors.js");

test("an error shown on the screen is logged once until it changes or clears", () => {
  const el = document.querySelector("p");
  showError(el, "library", "folder is missing");
  assert.equal(el.textContent, "folder is missing");
  assert.equal(el.dataset.error, "library", "the shown error carries the attribute that the error color selects");
  showError(el, "library", "folder is missing");
  showError(el, "library", "registry failed");
  hideError(el, "library");
  assert.equal(el.dataset.error, undefined);
  showError(el, "library", "registry failed");
  assert.deepEqual(lines.splice(0), [
    "error: library: folder is missing", "error: library: registry failed", "error: library: registry failed",
  ]);
});
