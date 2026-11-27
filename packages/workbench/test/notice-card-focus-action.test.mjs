// A warning or error of a card that does not have the focus shows as a toast with the action Go to card, which runs
// core.card.focus {card} (docs/spec/notifications.md#toasts). The focused card and the app notices have no such action.
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

const card = (name) => ({ kind: "card", card: name, tab: "t1", plugin: "p" });
const actionsOf = (document, title) => {
  const toast = [...document.querySelectorAll("#toasts > .toast")].find((node) => node.querySelector(".toast__title").textContent === title);
  return toast ? [...toast.querySelectorAll(".toast__actions button")].map((button) => ({ label: button.textContent, command: button.dataset.command, params: JSON.parse(button.dataset.params ?? "{}") })) : null;
};

test("a warning of a card without the focus shows the Go to card action (core.card.focus) that focuses the card", (t) => {
  const { document, store } = fixture(t);
  store.show({ kind: "warning", title: "disk low", source: card("c1") });
  assert.deepEqual(actionsOf(document, "disk low"), [{ label: "카드로 가기", command: "core.card.focus", params: { card: "c1" } }]);
});

test("an error of a card without the focus shows the same action after the notice's own actions", (t) => {
  const { document, store } = fixture(t);
  store.show({ kind: "error", title: "save failed", source: card("c2") });
  assert.deepEqual(actionsOf(document, "save failed"), [
    { label: "카드로 가기", command: "core.card.focus", params: { card: "c2" } },
    { label: "자세히", command: "core.notices.show", params: { id: store.toasts().find((t) => t.title === "save failed").id } },
  ]);
});

test("a card with the focus and an app warning show no Go to card action", (t) => {
  const { document, store } = fixture(t);
  store.focusCard("c3");
  store.show({ kind: "warning", title: "focused problem", source: card("c3") });
  store.show({ kind: "warning", title: "app problem" });
  assert.equal(actionsOf(document, "focused problem"), null, "a focused card shows no toast for its warning");
  assert.deepEqual(actionsOf(document, "app problem"), []);
});
