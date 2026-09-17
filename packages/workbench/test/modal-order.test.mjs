import assert from "node:assert/strict";
import test from "node:test";

import { modalOrder } from "../modal-order.js";

/** 적용한 호출을 순서대로 기록하는 모달 문서. */
function record() {
  const applied = [];
  const order = modalOrder(
    (content, card) => applied.push(["render", content.html, card]),
    (card) => applied.push(["place", card]),
  );
  return { applied, order };
}

const initial = { x: 320, y: 72 };
const moved = { x: 360, y: 92 };

test("a content answer older than a position event keeps the newer position", () => {
  const { applied, order } = record();
  order.content({ revision: 2, content: { html: "common", card: initial } });
  order.position({ revision: 3, card: moved });
  order.content({ revision: 1, content: { html: "initial", card: initial } });
  assert.deepEqual(applied, [["render", "common", initial], ["place", moved]]);
});

test("content newer than the applied content but older than the position keeps the placed card", () => {
  const { applied, order } = record();
  order.position({ revision: 2, card: moved });
  order.content({ revision: 1, content: { html: "old", card: initial } });
  order.content({ revision: 3, content: { html: "new", card: moved } });
  assert.deepEqual(applied, [["place", moved], ["render", "old", null], ["render", "new", moved]]);
});

test("a position older than applied content is dropped", () => {
  const { applied, order } = record();
  order.content({ revision: 4, content: { html: "latest", card: moved } });
  order.position({ revision: 3, card: initial });
  assert.deepEqual(applied, [["render", "latest", moved]]);
});
