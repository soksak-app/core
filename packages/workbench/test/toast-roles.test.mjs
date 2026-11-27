// The role of each toast and of each card status line: an error is announced as an alert, every other kind as a status
// (docs/spec/notifications.md#toasts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore } from "../tab-reports.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

function fixture(t) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document });
  beginSettings({ common: { toastStyle: "card" }, projects: [] }, null);
  const store = notificationStore();
  store.clearAll();
  if (store.status().open) store.toggle();
  store.setFilter("all");
  errorToasts(document);
  return { document, store };
}

test("an error toast has the role alert and every other toast the role status", (t) => {
  const { document, store } = fixture(t);
  store.show({ kind: "error", title: "save failed" });
  store.show({ kind: "warning", title: "disk low" });
  store.show({ kind: "success", title: "saved" });
  const roles = Object.fromEntries([...document.querySelectorAll("#toasts > .toast")].map((toast) => [toast.querySelector(".toast__title").textContent, toast.getAttribute("role")]));
  assert.deepEqual(roles, { "saved": "status", "disk low": "status", "save failed": "alert" });
});
