// 탭 알림의 시스템 알림(docs/spec/plugins.md#tab-reports).
import assert from "node:assert/strict";
import test from "node:test";
import { createSystemNotifications, DENIED_LINE } from "../system-notifications.js";

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

test("a new or changed notice is posted once with the tab name, and a removed notice is removed", async () => {
  const { calls, notifications, set } = fixture();
  set([["tab-a", "build finished"]]);
  notifications.sync();
  notifications.sync();
  set([["tab-a", "tests failed"], ["tab-b", "done"]]);
  notifications.sync();
  set([["tab-b", "done"]]);
  notifications.sync();
  await Promise.resolve();
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
  notifications.onChange(() => changed++);
  notifications.setState({ authorization: "authorized", error: null });
  notifications.sync();
  await new Promise((resolve) => setImmediate(resolve));
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

test("posted lists the tabs whose notification the center accepted until the notification is removed", async () => {
  const { notifications, set } = fixture();
  set([["tab-a", "one"], ["tab-b", "two"]]);
  notifications.sync();
  assert.deepEqual(notifications.state().posted, [], "a post is listed only after the center accepts it");
  notifications.posted({ surface: "tab-b" });
  notifications.posted({ surface: "tab-a" });
  notifications.posted({ surface: "tab-a" });
  assert.deepEqual(notifications.state().posted, ["tab-b", "tab-a"]);
  set([["tab-a", "one"]]);
  notifications.sync();
  await Promise.resolve();
  assert.deepEqual(notifications.state().posted, ["tab-a"]);
  notifications.setState({ authorization: "authorized", error: null });
  assert.deepEqual(notifications.state().posted, ["tab-a"], "a permission change keeps the posted tabs");
});
