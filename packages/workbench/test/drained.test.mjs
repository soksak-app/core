import assert from "node:assert/strict";
import { test } from "node:test";
import { drained } from "./support/drained.mjs";

// A chain of promises of any length and the next-tick queue between its steps end before the end of the microtask queue.
test("drained ends after a long chain of microtasks and the next ticks they queue", { timeout: 5000 }, async () => {
  const steps = [];
  let chain = Promise.resolve();
  for (let index = 0; index < 10000; index++) chain = chain.then(() => { steps.push(index); });
  chain.then(() => process.nextTick(() => queueMicrotask(() => steps.push("last"))));
  await drained();
  assert.equal(steps.length, 10001, "drained ended before the work of the chain");
  assert.equal(steps.at(-1), "last", "drained ended before a microtask queued by a next tick");
});
