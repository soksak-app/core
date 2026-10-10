// The debug view shows the host event files as a timeline: the rows, the filters, the status, the bound controls and the
// shown errors (docs/spec/debug.md).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const line = (event) => JSON.stringify(event);
const open = (boot) => line({ ts_us: 1, seq: 0, level: "info", layer: "host", event: "log.open", fields: { schema: 1, boot } });
const HOST = [
  open("a"),
  line({ ts_us: 30, seq: 2, level: "warn", layer: "page", event: "page.call.slow", fields: { name: "windows.list" } }),
  line({ ts_us: 20, seq: 1, level: "debug", layer: "host", event: "host.window.created", window: "w1" }),
].join("\n") + "\n";

async function openView(t, { entries, read }) {
  const dom = new JSDOM("<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  globalThis.CSS = { escape: (value) => value };
  const shown = [];
  const hidden = [];
  t.mock.module("../host.js", { namedExports: {
    native: false,
    debug: { record: async () => ({ path: "logs/state.json" }), files: async () => entries, read, save: async () => {}, saveAll: async () => {} },
    overlay: { show: () => {}, update: () => {}, place: () => {}, hide: () => {} },
  } });
  t.mock.module("../compositor.js", { namedExports: { standIn: () => {} } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  t.mock.module("../commands.js", { namedExports: {
    commandOf: () => null,
    delegate: () => {},
    mark: (el, name, params, valueName) => {
      el.dataset.command = name;
      if (valueName) el.dataset.value = valueName;
    },
    run: async () => {},
  } });
  t.mock.module("../exposure.js", { namedExports: { registry: { list: () => ({ status: [] }), registrants: () => [], handle: async () => ({}) } } });
  t.mock.module("../shown-errors.js", { namedExports: {
    hideError: (element, where) => hidden.push(where),
    showError: (element, where, text) => { element.textContent = text; shown.push({ where, text }); },
  } });
  const ui = await import(`../debug-ui.js?timeline-${Math.random()}`);
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  await ui.openDebug();
  t.after(() => { ui.closeDebug(); dom.window.close(); });
  return { ui, shown, hidden };
}

const rowsText = () => [...document.querySelectorAll('[data-expose="core.debug.timeline.row"]')].map((row) => row.textContent);
const entry = (path) => ({ path, size: 10, modified: 1 });

test("the timeline lists the rows of the host event files by time and filters them", async (t) => {
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl"), entry("logs/application.log")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
  });
  await ui.showDebugTimeline();
  assert.deepEqual(rowsText().map((text) => text.split(" ").slice(1, 4).join(" ")), ["info host log.open", "debug host host.window.created", "warn page page.call.slow"]);
  assert.deepEqual(ui.debugState().timeline, { sources: ["logs/host-a.jsonl"], truncated: [], total: 3, shown: 3, level: "trace", layer: "all", text: "" });
  ui.filterDebugTimeline({ level: "warn" });
  assert.equal(rowsText().length, 1);
  ui.filterDebugTimeline({ level: "trace", layer: "host", text: "WINDOW" });
  assert.deepEqual(rowsText().map((text) => text.split(" ")[3]), ["host.window.created"]);
  assert.equal(ui.debugState().timeline.shown, 1);
  assert.throws(() => ui.filterDebugTimeline({}), /timeline filter needs level, layer or text/);
  assert.throws(() => ui.filterDebugTimeline({ layer: "kernel" }), /timeline layer "kernel" is not one of/);
  ui.listDebugFiles();
  assert.equal(ui.debugState().timeline, null);
});

test("every interactive element of the timeline points to a declared command and has a dom name", async (t) => {
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
  });
  await ui.showDebugTimeline();
  const controls = [...document.querySelectorAll(".dbg-card button, .dbg-card input, .dbg-card select")];
  assert.ok(controls.some((el) => el.dataset.command === "core.debug.timeline.filter" && el.dataset.value === "text"));
  assert.ok(controls.some((el) => el.dataset.command === "core.debug.timeline.filter" && el.dataset.value === "level"));
  assert.ok(controls.some((el) => el.dataset.command === "core.debug.timeline.filter" && el.dataset.value === "layer"));
  assert.ok(controls.some((el) => el.dataset.command === "core.debug.timeline"));
  for (const el of controls) {
    assert.ok(el.dataset.command, `${el.outerHTML} has no command`);
    assert.ok(el.dataset.expose, `${el.outerHTML} has no dom name`);
  }
});

test("a truncated file drops its partial first line and is reported", async (t) => {
  const cut = `partial}\n${line({ ts_us: 5, seq: 4, level: "info", layer: "host", event: "host.x.y" })}\n`;
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: 999999, truncated: true, kind: "text", text: cut }),
  });
  await ui.showDebugTimeline();
  assert.equal(rowsText().length, 1);
  assert.deepEqual(ui.debugState().timeline.truncated, ["logs/host-a.jsonl"]);
});

test("a file that is not events is shown through the error display with its name and the failure is thrown", async (t) => {
  const { ui, shown } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: 3, truncated: false, kind: "text", text: `${line({ ts_us: 1, seq: 0, level: "info", layer: "host", event: "host.x.y" })}\n` }),
  });
  await assert.rejects(ui.showDebugTimeline(), /logs\/host-a\.jsonl: the first line is not log\.open/);
  assert.match(ui.debugState().error, /^timeline: logs\/host-a\.jsonl:/);
  assert.equal(shown.at(-1).where, "debug");
  assert.equal(ui.debugState().timeline, null);
});

test("a folder without a host event file is an error", async (t) => {
  const { ui } = await openView(t, { entries: [entry("logs/application.log")], read: async () => ({}) });
  await assert.rejects(ui.showDebugTimeline(), /logs\/ has no host event file/);
});
