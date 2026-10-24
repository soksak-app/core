import assert from "node:assert/strict";
import test from "node:test";
import { acceptedCurrentViewReplies } from "../reload-view-reply.mjs";

const pageEvent = (page, event, fields) => ({ ts_us: 10, level: "debug", layer: "page", page, event, fields });
const dispatch = (fields) => ({ ts_us: 1, level: "debug", layer: "host", event: "host.view.reply.dispatch", fields });
const query = { window: "main", page: "page-after-reload", plugin: "terminal", surface: "terminal-tab" };

test("native reply acceptance matches only the current page and source generation", () => {
  const events = [
    pageEvent("page-before-reload", "page.view.call", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 9, command: "runtime.shortcuts.read",
    }),
    pageEvent("page-before-reload", "page.view.reply", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 9, outcome: "result",
    }),
    pageEvent("page-after-reload", "page.view.call", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 9, command: "runtime.shortcuts.read",
    }),
    pageEvent("page-after-reload", "page.view.reply", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 9, outcome: "result",
    }),
    dispatch({ window: "main", page: "page-before-reload", surface: "terminal-tab", generation: 3, id: 9, outcome: "result", disposition: "posted" }),
    dispatch({ window: "main", page: "page-after-reload", surface: "terminal-tab", generation: 4, id: 9, outcome: "result", disposition: "posted" }),
    dispatch({ window: "other", page: "page-after-reload", surface: "terminal-tab", generation: 3, id: 9, outcome: "result", disposition: "posted" }),
    dispatch({ window: "main", page: "page-after-reload", surface: "terminal-tab", generation: 3, id: 12, outcome: "result", disposition: "discarded", reason: "view-generation-not-current" }),
    pageEvent("page-after-reload", "page.view.call", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 10, command: "runtime.shortcuts.read",
    }),
    pageEvent("page-after-reload", "page.view.reply", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 10, outcome: "result",
    }),
    dispatch({ window: "main", page: "page-after-reload", surface: "terminal-tab", generation: 3, id: 10, outcome: "result", disposition: "posted" }),
    pageEvent("page-after-reload", "page.view.call", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 11, command: "runtime.shortcuts.read",
    }),
    pageEvent("page-after-reload", "page.view.reply", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 11, outcome: "error",
    }),
    dispatch({ window: "main", page: "page-after-reload", surface: "terminal-tab", generation: 3, id: 11, outcome: "error", disposition: "posted" }),
    // A large unrelated page.call may be truncated without affecting the host-dispatch join.
    pageEvent("page-after-reload", "page.call", { name: "viewReply", truncated: true }),
  ];
  assert.deepEqual(acceptedCurrentViewReplies(events, query), [
    { ...query, generation: 3, id: 10, outcome: "result" },
    { ...query, generation: 3, id: 11, outcome: "error" },
  ]);
  assert.deepEqual(acceptedCurrentViewReplies(events.filter((event) =>
    !(event.layer === "host" && event.event === "host.view.reply.dispatch" && event.fields.id === 10)), query), [
    { ...query, generation: 3, id: 11, outcome: "error" },
  ], "a source reply without native post acceptance was treated as accepted");
  assert.throws(() => acceptedCurrentViewReplies([...events,
    dispatch({ window: "main", page: "page-after-reload", surface: "terminal-tab", generation: 3, id: 10, outcome: "result", disposition: "posted" }),
  ], query), /2 native dispatch records/);
  assert.throws(() => acceptedCurrentViewReplies([...events,
    dispatch({ window: "main", page: "page-after-reload", surface: "terminal-tab", generation: 3, id: 13, outcome: "other", disposition: "posted" }),
  ], query), /has invalid fields/);
  assert.throws(() => acceptedCurrentViewReplies([...events,
    dispatch({ window: "main", page: "page-after-reload", surface: "terminal-tab", generation: 3, id: 14, outcome: "result", disposition: "discarded", reason: "unknown" }),
  ], query), /invalid discard reason/);
});
