// The notice commands of core.notices run the one path of tab.notify, tab.progress and tab.done, and read marks an entry read
// (docs/spec/notifications.md#commands-and-statuses). A refused command fails with -32602 and the text of the check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<main><div id="plane"></div><svg id="railPath"></svg><div id="drop"></div><div id="focusMark"></div><div id="picker"></div></main>', { url: "http://localhost/" });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.location = dom.window.location;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const { registerPlugin } = await import("../registry.js");
const { registry } = await import("../exposure.js");
const { installErrorExposure } = await import("../core-exposure.js");
const { notificationStore, tabNotices } = await import("../tab-reports.js");

registerPlugin({ id: "fixture-commands", surface: () => null });
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
installErrorExposure();

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
  assert.fail("the command was not refused");
};
const entry = (id) => notificationStore().entries().find((e) => e.id === id);

test("core.notices.add gives a plugin a notice with the plugin as its source and returns its id", async () => {
  const id = await registry.run("core.notices.add", { plugin: "fixture-commands", kind: "info", title: "Added" });
  assert.equal(typeof id, "string");
  assert.deepEqual(entry(id).source, { kind: "plugin", plugin: "fixture-commands" });
  assert.equal(entry(id).title, "Added");
});

test("core.notices.add takes exactly one of card and plugin", async () => {
  assert.deepEqual(await refusal(registry.run("core.notices.add", { kind: "info", title: "Both", card: "c", plugin: "fixture-commands" })),
    { code: -32602, message: "core.notices.add takes exactly one of card and plugin" });
  assert.deepEqual(await refusal(registry.run("core.notices.add", { kind: "info", title: "Neither" })),
    { code: -32602, message: "core.notices.add takes exactly one of card and plugin" });
});

test("core.notices.add refuses a plugin that does not exist and a field that tab.notify refuses", async () => {
  assert.deepEqual(await refusal(registry.run("core.notices.add", { plugin: "no-such", kind: "info", title: "x" })),
    { code: -32602, message: "plugin no-such does not exist" });
  assert.deepEqual(await refusal(registry.run("core.notices.add", { plugin: "fixture-commands", kind: "loud", title: "x" })),
    { code: -32602, message: "a notice kind must be success, info, warning, error or progress" });
});

test("core.notices.add with plugin and system keeps a system notification under the plugin id", async () => {
  const id = await registry.run("core.notices.add", { plugin: "fixture-commands", kind: "info", title: "Sys", system: true });
  assert.deepEqual(entry(id).source, { kind: "plugin", plugin: "fixture-commands" });
  assert.ok(tabNotices().some(([key, text]) => key === "fixture-commands" && text === "Sys"));
});

test("core.notices.progress sets a progress notice and refuses an out-of-range value", async () => {
  const id = await registry.run("core.notices.add", { plugin: "fixture-commands", kind: "progress", title: "Import" });
  await registry.run("core.notices.progress", { id, progress: 0.5 });
  assert.equal(entry(id).progress, 0.5);
  assert.deepEqual(await refusal(registry.run("core.notices.progress", { id, progress: 2 })),
    { code: -32602, message: "a notice progress must be a number from 0 to 1, or null while the amount is unknown" });
});

test("core.notices.done ends a progress notice and refuses a notice that is not in progress", async () => {
  const id = await registry.run("core.notices.add", { plugin: "fixture-commands", kind: "progress", title: "Export" });
  await registry.run("core.notices.done", { id, kind: "success", title: "Exported" });
  assert.equal(entry(id).kind, "success");
  assert.equal(entry(id).title, "Exported");
  const info = await registry.run("core.notices.add", { plugin: "fixture-commands", kind: "info", title: "Plain" });
  assert.deepEqual(await refusal(registry.run("core.notices.done", { id: info, kind: "success", title: "Plain" })),
    { code: -32602, message: `notice ${info} is not a progress notice` });
});

test("core.notices.read marks one entry read and refuses an id that no entry has", async () => {
  const id = await registry.run("core.notices.add", { plugin: "fixture-commands", kind: "info", title: "Unread" });
  assert.equal(entry(id).read, false);
  await registry.run("core.notices.read", { id });
  assert.equal(entry(id).read, true);
  assert.deepEqual(await refusal(registry.run("core.notices.read", { id: "notice-unknown" })),
    { code: -32602, message: "notice notice-unknown is not an entry" });
});

test("core.notices.progress refuses a notice that is not in progress", async () => {
  const info = await registry.run("core.notices.add", { plugin: "fixture-commands", kind: "info", title: "Steady" });
  assert.deepEqual(await refusal(registry.run("core.notices.progress", { id: info, progress: 0.5 })),
    { code: -32602, message: `notice ${info} is not a progress notice` });
});
