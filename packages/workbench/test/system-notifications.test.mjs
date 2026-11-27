// System notifications of tab reports (docs/spec/plugins.md#tab-reports).
import assert from "node:assert/strict";
import test from "node:test";
import { createSystemNotifications, DENIED_LINE } from "../system-notifications.js";
import { setTargetOfTab } from "../tab-reports.js";
// The plane tells the card and the target of each tab; the tabs of this file are held by the card card-test.
setTargetOfTab((id) => ({ card: "card-test", tab: id, plugin: "probe", label: `label ${id}` }));

function fixture() {
  const calls = [];
  let current = new Map();
  const selected = [];
  const notifications = createSystemNotifications({
    post: async (request) => { calls.push(["post", request]); },
    remove: async (request) => { calls.push(["remove", request]); },
    notices: () => [...current],
    tabName: (tab) => `name of ${tab}`,
    select: async (tab) => { selected.push(tab); },
  });
  return { calls, selected, notifications, set: (entries) => { current = new Map(entries); } };
}

test("a new or changed notice is posted once with the tab name, and a removed notice is removed", () => {
  const { calls, notifications, set } = fixture();
  set([["tab-a", "build finished"]]);
  notifications.sync();
  notifications.sync();
  set([["tab-a", "tests failed"], ["tab-b", "done"]]);
  notifications.sync();
  set([["tab-b", "done"]]);
  notifications.sync();
  // The post and remove calls of the host are recorded when sync makes them, so the calls are complete once sync has run.
  assert.deepEqual(calls, [
    ["post", { surface: "tab-a", title: "name of tab-a", body: "build finished" }],
    ["post", { surface: "tab-a", title: "name of tab-a", body: "tests failed" }],
    ["post", { surface: "tab-b", title: "name of tab-b", body: "done" }],
    ["remove", { surface: "tab-a" }],
  ]);
});

test("an activated notification selects its tab, and a failed post becomes the state error", async () => {
  const selected = [];
  const notifications = createSystemNotifications({
    post: async () => { throw new Error("notification title must be 1 to 256 characters"); },
    remove: async () => {},
    notices: () => [["tab-a", "x"]],
    tabName: () => "name",
    select: async (tab) => { selected.push(tab); },
  });
  let changed = 0;
  // The first change is the state change below. The second change is the failed post, which the state reports after the rejection.
  const failure = new Promise((resolve) => notifications.onChange(() => {
    changed++;
    if (changed === 2) resolve();
  }));
  notifications.setState({ authorization: "authorized", error: null });
  notifications.sync();
  await failure;
  assert.deepEqual(notifications.state(),
    { authorization: "authorized", error: "post: notification title must be 1 to 256 characters", posted: [] });
  assert.equal(changed, 2);
  await notifications.activated({ surface: "tab-a" });
  assert.deepEqual(selected, ["tab-a"]);
});

test("while permission is denied a notice tooltip ends with the denied line", () => {
  const { notifications } = fixture();
  assert.equal(notifications.tooltip("done"), "done");
  notifications.setState({ authorization: "denied", error: null });
  assert.equal(notifications.tooltip("done"), `done\n${DENIED_LINE}`);
  assert.equal(DENIED_LINE, "System notifications are turned off for this application.");
});

test("posted lists the tabs whose notification the center accepted until the notification is removed", () => {
  const { notifications, set } = fixture();
  set([["tab-a", "one"], ["tab-b", "two"]]);
  notifications.sync();
  assert.deepEqual(notifications.state().posted, [], "a post is listed only after the center accepts it");
  notifications.posted({ surface: "tab-b" });
  notifications.posted({ surface: "tab-a" });
  notifications.posted({ surface: "tab-a" });
  assert.deepEqual(notifications.state().posted, ["tab-b", "tab-a"]);
  set([["tab-a", "one"]]);
  // The removal of an accepted notice is applied by sync itself, so the list is complete once sync has run.
  notifications.sync();
  assert.deepEqual(notifications.state().posted, ["tab-a"]);
  notifications.setState({ authorization: "authorized", error: null });
  assert.deepEqual(notifications.state().posted, ["tab-a"], "a permission change keeps the posted tabs");
});

test("an accepted system notice that a later tab notice of the tab replaces is removed and no longer posted", async () => {
  const { reportNotice, tabNotices } = await import("../tab-reports.js");
  const calls = [];
  const notifications = createSystemNotifications({
    post: async (request) => { calls.push(["post", request]); },
    remove: async (request) => { calls.push(["remove", request]); },
    notices: tabNotices,
    tabName: (tab) => `name of ${tab}`,
    select: async () => {},
  });
  reportNotice("tab-replaced", { kind: "info", title: "SYSTEM-NOTICE", text: "", system: true });
  notifications.sync();
  notifications.posted({ surface: "tab-replaced" });
  assert.deepEqual(notifications.state().posted, ["tab-replaced"]);
  reportNotice("tab-replaced", { kind: "info", title: "TAB-NOTICE", text: "" });
  notifications.sync();
  assert.deepEqual(calls, [
    ["post", { surface: "tab-replaced", title: "name of tab-replaced", body: "SYSTEM-NOTICE" }],
    ["remove", { surface: "tab-replaced" }],
  ]);
  assert.deepEqual(notifications.state().posted, [], "the notification that the tab notice replaced is still posted");
});
