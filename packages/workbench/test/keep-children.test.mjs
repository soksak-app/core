// A tab strip draws again while a person presses one of its tabs. An element that the draw replaces loses its click, because the
// browser produces a click only when the press and the release reach the same connected element.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { keepChildren } from "../keep-children.js";

function strip() {
  const { document } = new JSDOM("<div id=strip></div>").window;
  const container = document.getElementById("strip");
  const item = (key) => ({ key, create: () => Object.assign(document.createElement("button"), { textContent: key }) });
  return { container, item };
}

test("a draw between a press and its release keeps the connected pressed element", () => {
  const { container, item } = strip();
  keepChildren(container, [item("one"), item("two"), item("add")]);
  const pressed = container.children[0];
  const observer = new container.ownerDocument.defaultView.MutationObserver(() => {});
  observer.observe(container, { childList: true });
  keepChildren(container, [item("one"), item("two"), item("add")]);
  assert.equal(container.children[0], pressed, "the draw replaced the pressed element");
  assert.equal(pressed.isConnected, true);
  assert.deepEqual(observer.takeRecords(), [], "an unchanged list touches no child of the strip");
});

test("a change of another element leaves the pressed element in place", () => {
  const { container, item } = strip();
  keepChildren(container, [item("one"), item("two"), item("add")]);
  const [pressed, add] = [container.children[0], container.children[2]];
  const observer = new container.ownerDocument.defaultView.MutationObserver(() => {});
  observer.observe(container, { childList: true });
  keepChildren(container, [item("one"), item("two renamed"), item("three"), item("add")]);
  const removed = observer.takeRecords().flatMap((record) => [...record.removedNodes]);
  assert.equal(removed.includes(pressed), false, "the draw took the pressed element out of the document");
  assert.deepEqual([...container.children].map((child) => child.textContent), ["one", "two renamed", "three", "add"]);
  assert.equal(container.children[0], pressed);
  assert.equal(container.children[3], add);
});

test("an element whose key left the list leaves the document and a new order moves the elements", () => {
  const { container, item } = strip();
  keepChildren(container, [item("one"), item("two"), item("three")]);
  const [one, two, three] = container.children;
  keepChildren(container, [item("three"), item("one")]);
  assert.equal(container.children.length, 2);
  assert.equal(container.children[0], three);
  assert.equal(container.children[1], one);
  assert.equal(two.isConnected, false);
  keepChildren(container, []);
  assert.equal(container.children.length, 0);
});
