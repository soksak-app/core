// A window applies a plugin change by reloading its page after the questions of its modified tabs
// (docs/spec/installation.md#applying-a-change).
import assert from "node:assert/strict";
import test from "node:test";
import { createPluginApply } from "../plugin-apply.js";

function steps(settled) {
  const done = [];
  const apply = createPluginApply({
    settle: async () => { done.push("settle"); return settled; },
    flush: async () => { done.push("flush"); },
    reload: () => { done.push("reload"); },
  });
  return { apply, done };
}

test("a window whose modified tabs are settled saves its projects and reloads its page", async () => {
  const { apply, done } = steps(true);
  assert.deepEqual(await apply(), { reloaded: true });
  assert.deepEqual(done, ["settle", "flush", "reload"]);
});

test("a window that keeps a modified tab keeps its page", async () => {
  const { apply, done } = steps(false);
  assert.deepEqual(await apply(), { reloaded: false });
  assert.deepEqual(done, ["settle"]);
});
