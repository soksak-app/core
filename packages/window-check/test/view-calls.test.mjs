import assert from "node:assert/strict";
import test from "node:test";
import { unansweredViewCalls } from "../view-calls.mjs";

// A host event as the event reader returns it: the record of a page carries its page identifier and its fields.
const record = (ts_us, event, fields, page = "p1") => ({ ts_us, level: event.endsWith(".reply") || event.endsWith(".call") ? "debug" : "info",
  layer: "page", page, event, fields });
const call = (ts_us, id, command, page = "p1") => record(ts_us, "page.view.call", { plugin: "fixture-plugin", surface: "fixture-surface-a", id, command }, page);
const reply = (ts_us, id, outcome = "result", page = "p1") => record(ts_us, "page.view.reply", { plugin: "fixture-plugin", surface: "fixture-surface-a", id, outcome }, page);

test("a view call without a reply of its id is listed with its command, id and waiting time", () => {
  const events = [
    call(1_000_000, 7, "composition.declaration"),
    reply(1_010_000, 7),
    call(1_020_000, 8, "runtime.sidecar.send"),
    record(4_020_000, "page.view.call", { plugin: "other-plugin", surface: "fixture-surface-b", id: 1, command: "tab.title" }, "p1"),
  ];
  assert.deepEqual(unansweredViewCalls(events), [
    { plugin: "fixture-plugin", surface: "fixture-surface-a", id: 8, command: "runtime.sidecar.send", receivedUs: 1_020_000, waitingUs: 3_000_000 },
    { plugin: "other-plugin", surface: "fixture-surface-b", id: 1, command: "tab.title", receivedUs: 4_020_000, waitingUs: 0 },
  ]);
});

test("a reply matches its call only on the same page, plugin, surface and id", () => {
  const events = [
    call(1_000_000, 7, "runtime.settings.read", "p1"),
    reply(1_500_000, 7, "result", "p2"),
  ];
  assert.deepEqual(unansweredViewCalls(events).map(({ id }) => id), [7]);
});

test("records of other events are ignored and a call with an error reply is answered", () => {
  const events = [
    record(1_000_000, "page.start", { url: "sok://fixture-plugin/ui/page.html" }),
    call(1_100_000, 3, "runtime.log"),
    reply(1_200_000, 3, "error"),
  ];
  assert.deepEqual(unansweredViewCalls(events), []);
});
