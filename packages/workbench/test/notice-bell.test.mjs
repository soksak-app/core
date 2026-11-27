// The bell of the title bar (docs/spec/notifications.md#bell): the count of unread notices, the error token while an unread notice is a
// warning or an error and the accent otherwise, and the tooltip.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { registry } from "../exposure.js";
import { createBell } from "../notice-view.js";
import { createNotices } from "../notices.js";

// The bell runs core.notices.toggle, the one command this test needs.
registry.declare("core", { status: [], element: [], commands: [{
  name: "core.notices.toggle", description: "Opens or closes the center.", params: { type: "object", properties: {} }, result: { type: "null" },
}] });

function fixture(t) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const store = createNotices({ settings: () => "popover", view: globalThis, log: () => {}, onChange: () => {} });
  const bell = createBell(dom.window.document, store);
  return { store, bell, count: () => bell.querySelector(".notice-bell__count") };
}

test("the bell shows the unread count in the accent, and in the error token while an unread notice is a warning or an error", (t) => {
  const { store, bell, count } = fixture(t);
  bell.refresh();
  assert.equal(count().hidden, true, "no number while every notice is read");
  assert.equal(bell.title, "알림 센터");
  store.show({ kind: "info", title: "built" });
  bell.refresh();
  assert.equal(count().textContent, "1");
  assert.equal(bell.dataset.tone, "accent");
  assert.equal(bell.title, "알림 센터, 읽지 않음 1개");
  store.show({ kind: "warning", title: "waits" });
  bell.refresh();
  assert.equal(count().textContent, "2");
  assert.equal(bell.dataset.tone, "problem");
});
