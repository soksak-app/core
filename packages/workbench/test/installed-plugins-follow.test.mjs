// A window subscribes to plugins-changed and then reads the plugin state once, so a change that the host made before the
// subscription is applied as well; an event during a running apply runs one more apply after it, which reads the
// state again (docs/spec/installation.md#applying-a-change, F199.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";

test("a change before the subscription is applied, and a newer change during the apply runs one more apply", { timeout: 5000 }, async () => {
  // The case selects the host of the page before the module below is imported, because the page reads the host when it is imported.
  // The case holds the state that the host had before the subscription, and the state after the notice of the change.
  const wire = selectPageWire("installed-plugins-follow-change");
  const { followPluginChanges, pluginOperations } = await import("../installed-plugins.js");
  const seen = [];
  const finishes = [];
  // The starts of the applies and the end of the first, in their order.
  const order = [];
  // arrival() gives a promise that resolves when the next apply starts.
  let applied = () => {};
  const arrival = () => new Promise((resolve) => { applied = resolve; });
  const firstApply = arrival();
  const following = followPluginChanges(() => {
    seen.push(pluginOperations.status().plugins.map((row) => row.id));
    order.push("start");
    applied();
    return new Promise((resolve) => { finishes.push(resolve); });
  });
  await firstApply;
  assert.deepEqual(seen, [["a"]], "the change made before the subscription was not applied");
  // The host installs `b` while the first apply runs. deliverNotice fails when the window has no listener for plugins-changed.
  // The wait for the second start is registered before the event, so a second apply that starts during the event is recorded in order.
  const secondApply = arrival();
  wire.deliverNotice();
  order.push("first ended");
  finishes[0]({ reloaded: false });
  await secondApply;
  assert.deepEqual(order, ["start", "first ended", "start"], "a second apply ran while the first one ran");
  assert.deepEqual(seen, [["a"], ["a", "b"]], "the change made during the apply was not applied");
  finishes[1]({ reloaded: false });
  await following;
  // deliverNotice does not return the promise of the listener, so the microtasks that end the listener are drained here.
  await new Promise((resolve) => setImmediate(resolve));
  wire.finish();
});
