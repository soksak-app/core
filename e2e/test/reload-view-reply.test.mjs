import assert from "node:assert/strict";
import test from "node:test";
import { acceptedCurrentViewReplies } from "../reload-view-reply.mjs";

const record = (ts_us, event, page, fields) => ({
  ts_us, level: "debug", layer: "page", page, event, fields,
});

test("a host-accepted viewReply matches only its page source generation", () => {
  const events = [
    record(10, "page.view.call", "page-before-reload", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 9, command: "runtime.shortcuts.read",
    }),
    record(20, "page.view.reply", "page-before-reload", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 9, outcome: "result",
    }),
  ];
  const accepted = (id, generation) => `host viewReply ${JSON.stringify({
    id, result: null, generation, surface: "terminal-tab",
  })} -> null`;

  assert.deepEqual(acceptedCurrentViewReplies(events, [accepted(9, 4)], {
    page: "page-before-reload", plugin: "terminal", surface: "terminal-tab",
  }), [], "a host call from another source generation was treated as the current receipt");
  assert.deepEqual(acceptedCurrentViewReplies(events, [accepted(9, 3)], {
    page: "page-after-reload", plugin: "terminal", surface: "terminal-tab",
  }), [], "a post-offset reply from the old page was treated as a receipt of the replacement page");

  events.push(
    record(30, "page.view.call", "page-after-reload", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 10, command: "runtime.shortcuts.read",
    }),
    record(40, "page.view.reply", "page-after-reload", {
      plugin: "terminal", surface: "terminal-tab", generation: 3, id: 10, outcome: "result",
    }),
  );
  assert.deepEqual(acceptedCurrentViewReplies(events, [accepted(10, 3)], {
    page: "page-after-reload", plugin: "terminal", surface: "terminal-tab",
  }), [{ page: "page-after-reload", plugin: "terminal", surface: "terminal-tab", generation: 3, id: 10, outcome: "result" }]);
});
