// Checks the view document of the testing module (packages/plugin-api/testing.js): the real view bridge and the real exposure run
// over a jsdom window, the peer answers the calls of the view with the replies of a view-wire case
// (docs/spec/cases/view-wire/README.md), and the requests of the host reach the view as they do in the application.
import assert from "node:assert/strict";
import test from "node:test";
import { openView, turn } from "../testing.js";

const START = { surface: "tab-1", params: null, origin: { directory: null }, project: null, section: null };
const DECLARATIONS = {
  status: [{ name: "probe.count", description: "The count.", schema: { type: "object" } }],
  commands: [{ name: "probe.add", description: "Adds.", params: { type: "object" }, result: { type: "null" } }],
};

test("a command of the view is run by a request of the host and its reply is the result", { timeout: 5000 }, async () => {
  const view = await openView("testing-command-request", { start: START, declarations: DECLARATIONS });
  await view.bridge.commands.register("probe.add", async ({ by }) => {
    if (typeof by !== "number") throw new TypeError("probe.add requires a number");
    return null;
  });
  assert.equal(await view.run("probe.add", { by: 2 }), null);
  await assert.rejects(view.run("probe.add", { by: "x" }), /probe.add requires a number/);
  assert.deepEqual(view.calls.map(({ command }) => command).filter((command) => command === "runtime.command.register"), ["runtime.command.register"]);
  await view.close();
});

test("a status of the exposure is read and watched through the exposure request that the host forwards", { timeout: 5000 }, async () => {
  const view = await openView("testing-status-watch", { start: START, declarations: DECLARATIONS });
  let value = { count: 1 };
  const listeners = new Set();
  await view.expose.status("probe.count", () => value, (listener) => { listeners.add(listener); return () => listeners.delete(listener); });
  assert.deepEqual(view.registered("status"), ["probe.count"]);
  assert.deepEqual(await view.status("probe.count"), { count: 1 });
  await view.exposed("status.watch", { name: "probe.count" });
  value = { count: 2 };
  for (const listener of listeners) listener(value);
  await turn();
  assert.deepEqual(view.changes("probe.count"), [{ count: 1 }, { count: 2 }]);
  await view.close();
});

test("a call of the view that the host refuses fails with the message of the refusal", { timeout: 5000 }, async () => {
  const view = await openView("testing-refused-call", { start: START });
  await assert.rejects(view.bridge.calls.request("runtime.clipboard.read", "image"), /runtime.clipboard.read image is not served/);
  await view.close();
});

test("the events of the writer of the page are taken from its batches", { timeout: 5000 }, async () => {
  const view = await openView("testing-writer-batches", { start: START });
  view.bridge.runtime.log.info("started", { n: 1 });
  const event = await view.logged("plugin.probe.started");
  assert.deepEqual(event.fields, { n: 1 });
  await view.close();
});

test("a call that the case does not record is refused and close names it", { timeout: 5000 }, async () => {
  const view = await openView("testing-refused-call", { start: START });
  await assert.rejects(view.bridge.calls.request("tab.title", "x"), /testing-refused-call: step 0: call.command: the case expects "runtime.clipboard.read", the view sent "tab.title"/);
  await assert.rejects(view.close(), /testing-refused-call: step 0: call.command/);
});

test("a case that is not played to its end fails at close", { timeout: 5000 }, async () => {
  const view = await openView("testing-command-request", { start: START, declarations: DECLARATIONS });
  await assert.rejects(view.close(), /testing-command-request: \d+ steps of the case were not played/);
});
