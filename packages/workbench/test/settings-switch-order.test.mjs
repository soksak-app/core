// The press of a window sidebar switch applies the value in its own turn: the listeners that draw the plane run before the host
// writes the settings, and the change answers once the host wrote them (docs/spec/external-sidebars.md#window-controls).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { HostWorkspaceStore } from "../host-store.js";

test("a switch reaches the drawing before the settings write, and answers after the write", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  // The host calls of the page are answered by the page-wire case (docs/spec/cases/page-wire/README.md). The write of the settings is held until the test releases it.
  const wire = selectPageWire("settings-switch-order");
  const order = [];
  // The page without an operation sink stores no first event of an operation, so the write carries no identifiers.
  const { installOperationSink } = await import("../operations.js");
  await import("../page-log.js");
  installOperationSink(null);
  const { connectSettings, onSettingsChange, set: change, value } = await import("../settings.js?test=switch-order");
  const { orderedCallsAnswered } = await import("../host.js");
  try {
    await connectSettings(new HostWorkspaceStore(host));
    await orderedCallsAnswered();
    onSettingsChange(() => order.push(`draw left ${value("left")}`));
    let answered = false;
    const pending = change({ left: false }, "common", "core.settings.set").then(() => { answered = true; });
    assert.deepEqual(order, ["draw left false"], "the change reached the drawing after the write started");
    await orderedCallsAnswered();
    // The write starts after the snapshot is read, and the page sends it to the host.
    const written = wire.calls.filter(({ name, payload }) => name === "workspace" && payload.kind === "settings");
    assert.deepEqual(written.map(({ payload }) => payload.patch), [{ left: false }]);
    assert.equal(answered, false, "the change answered before the host wrote the settings");
    wire.release();
    await pending;
    assert.equal(answered, true);
    await orderedCallsAnswered();
    wire.finish();
  } finally {
    dom.window.close();
  }
});
