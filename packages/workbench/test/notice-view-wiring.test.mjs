// The toast bar redraws when the shown toasts change, and the center redraws on every change of an entry, so a center toggle changes no
// node of the toast bar (docs/spec/notifications.md#toasts). The draws are counted as the mutations of the document, which the page
// makes when it writes a node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { registry } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore } from "../tab-reports.js";

registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);

const dom = new JSDOM("<body></body>");
const { document } = dom.window;
Object.assign(globalThis, { window: dom.window, document });
beginSettings({ common: {}, projects: [] }, null);
errorToasts(document);
const store = notificationStore();

// The mutations since the last call, split into those inside the toast bar and those outside it.
const observer = new dom.window.MutationObserver(() => {});
observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
function drawsSince() {
  const toasts = document.getElementById("toasts");
  const records = observer.takeRecords();
  return {
    toastBar: records.filter((record) => toasts.contains(record.target)).length,
    elsewhere: records.filter((record) => !toasts.contains(record.target)).length,
  };
}

test("a center toggle redraws the center and writes no node of the toast bar", () => {
  store.clearAll();
  store.show({ kind: "info", title: "shown toast" });
  drawsSince();
  store.toggle();
  const draws = drawsSince();
  store.toggle();
  drawsSince();
  assert.equal(draws.toastBar, 0, "the toast bar was drawn by a change that moves no toast");
  assert.ok(draws.elsewhere > 0, "the center was not drawn by the toggle");
});

test("a new toast redraws the toast bar", () => {
  store.clearAll();
  drawsSince();
  store.show({ kind: "info", title: "new toast" });
  const draws = drawsSince();
  assert.ok(draws.toastBar > 0, "the new toast was not drawn in the toast bar");
});
