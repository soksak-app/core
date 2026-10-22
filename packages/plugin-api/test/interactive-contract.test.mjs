// Runs the published INTERACTIVE cases (packages/plugin-api/contract/interactive.json) against the binder audit of core.
// Each case marks up a delegated root and lists the operable elements that the audit reports, in document order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { INTERACTIVE, createBinder } from "../binder.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/interactive.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "interactive.audit.lists-unconnected-and-unnamed-elements",
  "interactive.audit.text-takes-label-then-title-then-truncates",
];

test("INTERACTIVE is the published selector of operable elements", () => {
  assert.equal(INTERACTIVE, CONTRACT.selector);
});

test("published interactive cases are the required cases in order", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`binder audit ${testCase.id} matches the published rows`, () => {
    const { window } = new JSDOM(`<body><div id="root">${testCase.markup}</div></body>`);
    try {
      const root = window.document.getElementById("root");
      const binder = createBinder(() => Promise.resolve(), { check() {} });
      binder.delegate(root);
      assert.deepEqual(binder.audit(root), testCase.output);
    } finally {
      window.close();
    }
  });
}
