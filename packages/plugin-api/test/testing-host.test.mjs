// Checks the host mode of the view document of the testing module (testing.js of this package): openView answers each call of the
// view page through answerViewCall with the options of createTestHost, over the real view bridge and the real exposure of the SDK.
// The view page is the bridge calls below, which the page module of a plugin makes through the same bridge.
import assert from "node:assert/strict";
import test from "node:test";
import { openView } from "../testing.js";

const START = { surface: "probe-surface", params: null, origin: { directory: null }, project: null, section: null };
const PROJECT = { id: "p1", root: "/projects/p1" };

/** The fixtures of the view of plugin probe. Each call builds new fixtures, because a fixture can hold a state of its own. */
const fixtures = (extra = {}) => ({
  surface: "probe-surface",
  declarations: { status: [], commands: [], element: [] },
  contributions: [],
  project: PROJECT,
  data: { note: { schema: { type: "string" }, default: "default" } },
  sidecars: ["fixture-sidecar"],
  ...extra,
});

test("a data value that the view sets is read back by the view through the host", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  assert.equal(await view.bridge.runtime.data.get("note"), "default");
  await view.bridge.runtime.data.set("note", "written");
  assert.equal(await view.bridge.runtime.data.get("note"), "written");
  await view.settled();
  await view.close();
});

test("a call to a route without a fixture rejects in the view and close names the route", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  await assert.rejects(view.bridge.runtime.clipboard.writeText("text"), /view host: clipboard.writeText has no fixture/);
  await view.settled();
  await assert.rejects(view.close(), /view host: clipboard.writeText has no fixture/);
});

test("a declared fault point rejects the call of the view with its message", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures({ faults: { "clipboard.read": "clipboard is locked" } }) });
  await assert.rejects(view.bridge.runtime.clipboard.read("text"), /clipboard is locked/);
  await view.settled();
  await view.close();
});

test("a tab title that the view reports is recorded in the observed tab", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  await view.bridge.calls.request("tab.title", "Probe title");
  await view.settled();
  assert.equal(view.observed.tab.title, "Probe title");
  await view.close();
});

test("a sidecar send reaches the sidecar fixture and its reply returns to the view", { timeout: 5000 }, async () => {
  const view = await openView("probe", {
    start: START,
    host: fixtures({ sidecar: { "fixture-sidecar": (body) => ({ echo: body }) } }),
  });
  const reply = await view.bridge.runtime.sidecar("fixture-sidecar").send("probe-surface", { n: 1 });
  assert.deepEqual(reply, { echo: { n: 1 } });
  await view.settled();
  assert.deepEqual(view.observed.sidecar, [{ sidecar: "fixture-sidecar", id: "probe-surface", body: { n: 1 }, cids: [] }]);
  await view.close();
});

test("cases and host together, or neither, is refused with a TypeError that names the options", { timeout: 5000 }, async () => {
  const cases = new URL("../../../docs/spec/cases/view-wire/", import.meta.url);
  await assert.rejects(openView("probe", { cases, host: fixtures(), start: START }), {
    name: "TypeError",
    message: "openView takes either the case folder `cases` or the host fixtures `host`, not both",
  });
  await assert.rejects(openView("probe", { start: START }), {
    name: "TypeError",
    message: /openView requires the case folder `cases`/,
  });
});

test("host fixtures that name a plugin are refused, because the name of the view is its plugin", { timeout: 5000 }, async () => {
  await assert.rejects(openView("probe", { start: START, host: fixtures({ plugin: "other" }) }), {
    name: "TypeError",
    message: "openView host fixtures take no plugin: the plugin of the view is the name",
  });
});

test("a document state that the host pushes reaches the listener of the view", { timeout: 5000 }, async () => {
  const view = await openView("probe", { start: START, host: fixtures() });
  const states = [];
  await view.bridge.runtime.native.on("document-state", (data) => states.push(data));
  await view.push("document-state", { surface: "probe-surface", document: "page", state: { url: "https://example.invalid/" } });
  await view.settled();
  assert.deepEqual(states, [{ surface: "probe-surface", document: "page", state: { url: "https://example.invalid/" } }]);
  await view.close();
});
