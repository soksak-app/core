// The page notices of a view go through the view call route to the page handlers, which return the notice id (docs/spec/notifications.md#plugin-notices).
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall } from "../view-answer.js";
import { createTestHost } from "../view-host.js";

const host = () => createTestHost({ plugin: "probe", surface: "probe-surface" });

test("a page notice call gives the page the checked fields and replies the notice id", async () => {
  const view = host();
  assert.equal(await answerViewCall({ id: 1, command: "page.notify", params: { kind: "info", title: "Built" } }, view.options), "notice-1");
  assert.equal(await answerViewCall({ id: 2, command: "page.progress", params: { id: "notice-1", progress: 0.5 } }, view.options), null);
  assert.equal(await answerViewCall({ id: 3, command: "page.done", params: { id: "notice-1", kind: "success", title: "Built" } }, view.options), null);
  assert.deepEqual(view.observed.page, {
    notify: [{ kind: "info", title: "Built", text: "" }],
    progress: [{ id: "notice-1", progress: 0.5 }],
    done: [{ id: "notice-1", kind: "success", title: "Built" }],
  });
});

test("a page notice call refuses an invalid notice with the notice rule and reaches no page handler", async () => {
  const view = host();
  await assert.rejects(answerViewCall({ id: 1, command: "page.notify", params: { kind: "loud", title: "Built" } }, view.options),
    { message: "a notice kind must be success, info, warning, error or progress" });
  assert.deepEqual(view.observed.page.notify, []);
});
