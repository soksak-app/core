// The switch Quiet beside the filter of the notice center (docs/spec/notifications.md#notice-center): the element core.notices.quiet, which
// runs core.settings.set with the patch of quietToasts and the scope common, and shows its state as pressed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { mountNoticeView } from "../notice-view.js";
import { createNotices } from "../notices.js";
import { beginSettings } from "../settings.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

function openCenter(t, quiet) {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  beginSettings({ common: { quietToasts: quiet, noticeCenterStyle: "popover" }, projects: [] }, null);
  const store = createNotices({ settings: () => undefined, view: globalThis, log: () => {}, onChange: () => {} });
  const view = mountNoticeView(dom.window.document, store);
  store.show({ kind: "info", title: "Shown" });
  store.toggle();
  view.redraw();
  return dom.window.document;
}

test("the center has the Quiet switch (core.notices.quiet) that sets quietToasts to its opposite", (t) => {
  const document = openCenter(t, false);
  const quiet = document.querySelector('[data-expose="core.notices.quiet"]');
  assert.ok(quiet, "the open center has no switch core.notices.quiet");
  assert.equal(quiet.textContent, "조용히");
  assert.equal(quiet.getAttribute("aria-pressed"), "false");
  assert.equal(quiet.dataset.command, "core.settings.set");
  assert.deepEqual(JSON.parse(quiet.dataset.params), { patch: { quietToasts: true }, scope: "common" });
});
