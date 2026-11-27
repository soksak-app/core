// The status line of a card shows a success or info notice for six seconds, which is longer than a toast of the same kind shows
// (docs/spec/notifications.md#places).
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
  beginSettings({ common: {}, projects: [] }, null);
  const store = notificationStore();
  store.clearAll();
  if (store.status().open) store.toggle();
  store.setFilter("all");
  errorToasts(document);
  return store;
}

const card = { kind: "card", card: "c1", tab: "t1", plugin: "p" };

test("a success card notice shows on its status line for six seconds", (t) => {
  const store = fixture(t);
  store.show({ kind: "success", title: "saved", source: card });
  const line = store.lineOf("c1");
  assert.ok(line, "the card has no status line");
  assert.ok(line.line.remaining <= 6000 && line.line.remaining > 5000, `remaining ${line.line.remaining}`);
});
