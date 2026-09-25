// 호스트가 없는 문서(브라우저 예제)의 표면 인터페이스는 이 문서가 앉힌 자리를 실제 자리로 답한다.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<body></body>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { native, report, surfaces } = await import("../host.js");

test("without a host, place answers the rectangles the page seated", () => {
  assert.equal(native, false);
  const record = { surfaces: [{ id: "a", applied: { x: 1, y: 2, w: 3, h: 4 } }, { id: "b", applied: { x: 5, y: 6, w: 7, h: 8 } }] };
  assert.deepEqual(surfaces.place(record), [{ id: "a", x: 1, y: 2, w: 3, h: 4 }, { id: "b", x: 5, y: 6, w: 7, h: 8 }]);
});

test("without a host, report writes the line to the console as an error", () => {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try { report("surface probe mount failed: x"); } finally { console.error = original; }
  assert.deepEqual(lines, ["surface probe mount failed: x"]);
});
