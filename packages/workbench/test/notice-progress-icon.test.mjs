// The progress notice has a turning ring (docs/spec/notifications.md#notices): the icon table declares it, and the stylesheet turns it
// unless the person prefers reduced motion.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasIcon, icon } from "../icons.js";

test("the icon table declares the progress ring as a drawn path", () => {
  assert.equal(hasIcon("notice-progress"), true);
  assert.match(icon("notice-progress"), /<path d="M12 4a8 8 0 1 1-8 8"\/>/);
});

test("the stylesheet turns the progress ring and stops the turn under reduced motion", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  assert.match(css, /\.toast\[data-kind="progress"\] \.toast__mark svg[^{]*\{[^}]*animation: surface-status-spin/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\[data-kind="progress"\][^}]*animation: none/);
});

// A progress notice draws the turning ring of the icon table, not the info glyph (docs/spec/notifications.md#notices).
test("a progress toast draws the progress ring and no info glyph", async () => {
  const { JSDOM } = await import("jsdom");
  const { mountNoticeView } = await import("../notice-view.js");
  const { notificationStore } = await import("../tab-reports.js");
  const dom = new JSDOM("<body><div id=\"toasts\"></div></body>");
  globalThis.document = dom.window.document;
  const { installExposure } = await import("../exposure.js");
  installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));
  const store = notificationStore();
  store.clearAll();
  mountNoticeView(document, store);
  store.show({ kind: "progress", title: "working", progress: null });
  const mark = document.querySelector(".toast .toast__mark");
  assert.ok(mark, "the progress toast is not drawn");
  assert.match(mark.innerHTML, /M12 4a8 8 0 1 1-8 8/);
  assert.doesNotMatch(mark.innerHTML, /M12 8h\.01/);
});
