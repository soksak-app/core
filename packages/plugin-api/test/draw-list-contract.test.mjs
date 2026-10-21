// Runs ordered published drawList cases against the core implementation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { drawList } from "../list.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/draw-list.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "draw-list.keeps-unchanged-identity",
  "draw-list.reorders-and-reconciles-keys",
  "draw-list.refuses-duplicate-keys",
  "draw-list.removes-unmanaged-text",
];

export function runDrawListCase(testCase) {
  const dom = new JSDOM("<ul></ul>");
  const list = dom.window.document.querySelector("ul");
  if (testCase.initialText) list.append(dom.window.document.createTextNode(testCase.initialText));
  const identities = new WeakMap();
  const created = [];
  const updated = [];
  let nextIdentity = 0;
  const outputs = [];
  for (const step of testCase.steps) {
    let error = null;
    try {
      drawList(list, step.draw.entries, {
        key: (entry) => entry.id,
        create(entry) {
          const item = list.ownerDocument.createElement("li");
          item.append(list.ownerDocument.createElement("button"));
          identities.set(item, "n" + (++nextIdentity));
          created.push(entry.id);
          return item;
        },
        update(item, entry) {
          item.firstChild.textContent = entry.title;
          updated.push(entry.id + ":" + entry.title);
        },
      });
    } catch (reason) {
      error = reason.message;
    }
    outputs.push({
      order: [...list.children].map((item) => item.dataset.listKey),
      nodeIds: [...list.children].map((item) => identities.get(item)),
      text: [...list.children].map((item) => item.textContent),
      created: [...created],
      updated: [...updated],
      error,
    });
  }
  dom.window.close();
  return outputs;
}

test("drawList publishes ordered identity, ordering, duplicate, and cleanup cases", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test('drawList ' + testCase.id + ' matches each ordered step', () => {
    assert.deepEqual(runDrawListCase(testCase), testCase.steps.map(({ output }) => output));
  });
}
