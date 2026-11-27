// The three toast forms of the setting toastStyle (docs/spec/notifications.md#toasts): card shows three toasts and a count of the rest,
// line shows one toast with a red count of the others, deck shows the stack. A toast that closes by itself has its remaining time as its
// bar, and the pointer or the focus on a toast holds its notice, so no timer runs on it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings } from "../settings.js";
import { errorToasts } from "../shown-errors.js";
import { notificationStore } from "../tab-reports.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

function fixture(t, style) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document });
  beginSettings({ common: { toastStyle: style }, projects: [] }, null);
  const store = notificationStore();
  store.clearAll();
  if (store.status().open) store.toggle();
  store.setFilter("all");
  errorToasts(document);
  return { document, store };
}

const shownToasts = (document) => [...document.querySelectorAll("#toasts > .toast")];
const counter = (document) => document.querySelector("#toasts > .toast__more");

test("the card form shows three toasts and counts the rest, and an info toast has its remaining time as its bar", (t) => {
  const { document, store } = fixture(t, "card");
  for (const n of [1, 2, 3, 4]) store.show({ kind: "info", title: `note ${n}` });
  assert.equal(document.querySelector("#toasts").dataset.style, "card");
  assert.equal(shownToasts(document).length, 3);
  assert.equal(counter(document).textContent, "+1개 더");
  assert.equal(counter(document).hidden, false);
  assert.match(shownToasts(document)[0].querySelector(".toast__bar").style.animationDuration, /^\d+ms$/);
});

test("the line form shows one toast, and its counter holds the number of the others in the error tone", (t) => {
  const { document, store } = fixture(t, "line");
  for (const n of [1, 2, 3]) store.show({ kind: "info", title: `note ${n}` });
  assert.equal(document.querySelector("#toasts").dataset.style, "line");
  assert.equal(shownToasts(document).length, 1);
  assert.equal(counter(document).textContent, "2");
  assert.equal(counter(document).dataset.tone, "error", "the count of the others is red");
});

test("the deck form shows the whole stack and no count", (t) => {
  const { document, store } = fixture(t, "deck");
  for (const n of [1, 2, 3]) store.show({ kind: "info", title: `note ${n}` });
  assert.equal(document.querySelector("#toasts").dataset.style, "deck");
  assert.equal(shownToasts(document).length, 3);
  assert.equal(counter(document).hidden, true);
});

test("the pointer or the focus on a toast holds its notice while it is over, and the hold ends when it leaves", (t) => {
  const { document, store } = fixture(t, "card");
  const id = store.show({ kind: "info", title: "held" });
  const node = document.querySelector(`#toasts > .toast[data-notice="${id}"]`);
  node.dispatchEvent(new window.Event("pointerenter"));
  assert.equal(store.notice(id).holds, 1, "the pointer holds the notice");
  node.dispatchEvent(new window.Event("pointerleave"));
  assert.equal(store.notice(id).holds, 0, "leaving the toast releases the hold");
  node.dispatchEvent(new window.Event("focusin"));
  assert.equal(store.notice(id).holds, 1, "the keyboard focus holds the notice");
  node.dispatchEvent(new window.Event("focusout"));
  assert.equal(store.notice(id).holds, 0);
});

// The deck stack spreads under the pointer, and the toasts have no enter or leave animation: the bar of a toast is the only one, and
// reduced motion stops it (docs/spec/notifications.md#toasts).
test("the deck stack spreads on hover, and reduced motion stops the bar and leaves no toast animation", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  assert.match(css, /#toasts\[data-style="deck"\]:hover \.toast:not\(:first-child\) \{ transform: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.toast__bar \{ animation: none; \} \}/);
  assert.doesNotMatch(css, /\.toast(?:\[[^\]]*\])?\s*\{[^}]*animation:/, "a toast has no animation of its own");
});

test("running an action closes its toast and runs its command", async (t) => {
  const { document, store } = fixture(t, "card");
  const { registry } = await import("../exposure.js");
  const ran = [];
  registry.command("core.card.focus", (params) => { ran.push(params); });
  const id = store.show({ kind: "info", title: "saved", actions: [{ label: "카드로 가기", command: "core.card.focus", params: { card: "c1" } }] });
  const button = document.querySelector(`#toasts > .toast[data-notice="${id}"] .toast__action`);
  assert.equal(button.dataset.expose, "core.notices.action");
  assert.equal(button.dataset.command, "core.card.focus");
  button.click();
  assert.equal(store.toasts().some((toast) => toast.id === id), false, "the action closes the toast");
  await registry.commandsEnded();
  assert.deepEqual(ran, [{ card: "c1" }], "the action runs its command with its parameters");
});
