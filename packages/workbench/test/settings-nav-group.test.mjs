// core.settings-tab.nav with a group: the page scrolls the group with that id to the top of the pane, an unknown group is refused with
// -32602, and the gear of the notice center runs the nav to the group notices of the page behavior (docs/spec/settings.md#rows).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountNoticeView } from "../notice-view.js";
import { createNotices } from "../notices.js";
import { beginSettings } from "../settings.js";
import { openSettingsTab, startSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null);

test("core.settings-tab.nav scrolls the group with the named id to the top of the pane", async () => {
  await openSettingsTab(ctx);
  const scrolled = [];
  globalThis.Element.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this);
  };
  await ctx.run("core.settings-tab.nav", { page: "behavior", group: "notices" });
  const target = ctx.document.querySelector('[data-group="notices"]');
  assert.ok(target, "the page behavior draws no group with the id notices");
  assert.equal(target.querySelector(".set-group__name").textContent, "알림");
  assert.deepEqual(scrolled, [target], "the page did not scroll the group 알림 into view");
});

test("core.settings-tab.nav refuses an unknown group with -32602 and keeps the page", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "look" });
  await assert.rejects(ctx.run("core.settings-tab.nav", { page: "behavior", group: "missing" }), (error) => {
    assert.equal(error.code, -32602);
    assert.equal(error.message, 'unknown group "missing" of page "behavior"');
    return true;
  });
  assert.ok(ctx.document.querySelector('[data-group="theme"]'), "the refused command changed the page");
});

test("the gear of the notice center runs core.settings-tab.nav to the group notices of the page behavior", (t) => {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  beginSettings({ common: { noticeCenterStyle: "popover" }, projects: [] }, null);
  const store = createNotices({ settings: () => undefined, view: globalThis, log: () => {}, onChange: () => {} });
  const view = mountNoticeView(dom.window.document, store);
  store.show({ kind: "info", title: "Shown" });
  store.toggle();
  view.redraw();
  const gear = dom.window.document.querySelector('[data-expose="core.notices.settings"]');
  assert.ok(gear, "the open center has no gear core.notices.settings");
  assert.equal(gear.dataset.command, "core.settings-tab.nav");
  assert.deepEqual(JSON.parse(gear.dataset.params), { page: "behavior", group: "notices" });
});
