// A status that reads the surface of its request, such as core.tab.role (docs/spec/agent-roles.md#tab-role-state): the registry of a
// document gives that surface to the read and to the subscription of a watch and of a follow, and refuses a read or a watch without a
// surface before it subscribes, so a refused watch leaves no subscription.
import assert from "node:assert/strict";
import test from "node:test";
import { EXPOSURE_ERRORS, declarationMap, exposureEntries } from "../index.js";

const NAME = "probe.role";

function surfaceStatus() {
  const entries = exposureEntries(declarationMap({ status: [{ name: NAME, description: "The role of a tab.", type: "object" }] }));
  const subscribed = [];
  const reads = [];
  entries.status(NAME, (surface) => {
    reads.push(surface);
    if (surface === undefined) throw new Error(`read of ${NAME} without a surface`);
    return { surface };
  }, (fn, surface) => {
    const subscription = { surface, fn, stopped: false };
    subscribed.push(subscription);
    return () => { subscription.stopped = true; };
  }, { surface: true });
  return { entries, subscribed, reads };
}

test("a follow of a surface status without a surface is refused and leaves no subscription", { timeout: 5000 }, () => {
  const { entries, subscribed, reads } = surfaceStatus();
  assert.throws(() => entries.follow(NAME, () => {}), { message: `status.watch for ${NAME} requires a surface` });
  assert.deepEqual(subscribed.filter(({ stopped }) => !stopped).length, 0, "the refused follow left a subscription");
  assert.deepEqual(reads, [], "the refused follow read the status");
});

test("a follow of a surface status reads and subscribes with its surface", { timeout: 5000 }, async () => {
  const { entries, subscribed } = surfaceStatus();
  const values = [];
  const stop = entries.follow(NAME, (value) => values.push(value), "tab-a");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(values, [{ surface: "tab-a" }]);
  assert.deepEqual(subscribed.map(({ surface }) => surface), ["tab-a"]);
  subscribed[0].fn({ surface: "tab-a", changed: true });
  assert.deepEqual(values, [{ surface: "tab-a" }, { surface: "tab-a", changed: true }]);
  stop();
  assert.equal(subscribed[0].stopped, true);
});

test("a watch of a surface status subscribes with the surface of its request", { timeout: 5000 }, async () => {
  const { entries, subscribed } = surfaceStatus();
  const changes = [];
  assert.equal(await entries.answer("status.watch", { name: NAME, surface: "tab-a" }, (name, value) => changes.push(value)), null);
  assert.deepEqual(subscribed.map(({ surface }) => surface), ["tab-a"]);
  assert.deepEqual(changes, [{ surface: "tab-a" }]);
});

test("a read or a watch of a surface status without a surface is refused before it subscribes", { timeout: 5000 }, async () => {
  const { entries, subscribed, reads } = surfaceStatus();
  for (const method of ["status.get", "status.watch"]) {
    await assert.rejects(entries.answer(method, { name: NAME }),
      (refusal) => refusal.code === EXPOSURE_ERRORS.invalidParams && refusal.message === `${method} for ${NAME} requires a surface`, method);
  }
  assert.equal(subscribed.length, 0, "the refused watch subscribed");
  assert.deepEqual(reads, [], "the refused requests read the status");
});

test("a follow whose first read throws is refused with that error and leaves no subscription", { timeout: 5000 }, () => {
  const entries = exposureEntries(declarationMap({ status: [{ name: NAME, description: "The role of a tab.", type: "object" }] }));
  const subscribed = [];
  entries.status(NAME, (surface) => { throw new Error(`no role of ${surface}`); }, (fn, surface) => {
    const subscription = { surface, stopped: false };
    subscribed.push(subscription);
    return () => { subscription.stopped = true; };
  }, { surface: true });
  assert.throws(() => entries.follow(NAME, () => {}, "tab-a"), { message: "no role of tab-a" });
  assert.equal(subscribed.filter(({ stopped }) => !stopped).length, 0, "the refused follow left a subscription");
});

test("a changed status value that is a promise is refused instead of being sent as {}", { timeout: 5000 }, async () => {
  const { entries, subscribed } = surfaceStatus();
  const values = [];
  entries.follow(NAME, (value) => values.push(value), "tab-a");
  await Promise.resolve();
  await Promise.resolve();
  assert.throws(() => subscribed[0].fn(Promise.resolve({ surface: "tab-a", role: "a" })),
    { message: `status ${NAME} value is a promise; a status value is JSON, and a read that answers later delivers the value it resolves` });
  assert.deepEqual(values, [{ surface: "tab-a" }], "the follow delivered the promise");
});

// Two tab surfaces of one plugin register the same status. A read names the surface that it reads, so each request gets the value of
// its own surface and not the value of the first or the last registered surface.
test("a status read names a surface and returns the value of that surface when the plugin has two surfaces", { timeout: 5000 }, async () => {
  const screens = { "tab-a": "screen of tab-a", "tab-b": "screen of tab-b" };
  const reads = [];
  const entries = exposureEntries(declarationMap({ status: [{ name: NAME, description: "The screen of a tab.", type: "string" }] }));
  entries.status(NAME, (surface) => {
    reads.push(surface);
    if (!(surface in screens)) throw new Error(`no screen of ${surface}`);
    return screens[surface];
  }, () => () => {}, { surface: true });
  assert.equal(await entries.answer("status.get", { name: NAME, surface: "tab-b" }, () => {}), "screen of tab-b");
  assert.equal(await entries.answer("status.get", { name: NAME, surface: "tab-a" }, () => {}), "screen of tab-a");
  assert.deepEqual(reads, ["tab-b", "tab-a"]);
});
