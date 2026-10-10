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

async function openView(t, { entries, read, saveText = async () => ({ saved: null }) }) {
  const dom = new JSDOM("<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  globalThis.CSS = { escape: (value) => value };
  const shown = [];
  const hidden = [];
  t.mock.module("../host.js", { namedExports: {
    native: false,
    debug: { record: async () => ({ path: "logs/state.json" }), files: async () => entries, read, save: async () => {}, saveAll: async () => {}, saveText },
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

const WARNING = "저장한 파일에는 입력한 글자가 들어 있을 수 있다.";
const rowsText = () => [...document.querySelectorAll('[data-expose="core.debug.timeline.row"]')].map((row) => row.textContent);
const entry = (path) => ({ path, size: 10, modified: 1 });

test("the timeline lists the rows of the host event files by time and filters them", async (t) => {
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl"), entry("logs/application.log")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
  });
  await ui.showDebugTimeline();
  assert.deepEqual(rowsText().map((text) => text.split(" ").slice(1, 4).join(" ")), ["info host log.open", "debug host host.window.created", "warn page page.call.slow"]);
  assert.deepEqual(ui.debugState().timeline, { sources: ["logs/host-a.jsonl"], truncated: [], total: 3, shown: 3, selected: 0, warning: WARNING, level: "trace", layer: "all", text: "", event: "", surface: "", session: "", cid: "", from: "", to: "", context: "0", lines: 3 });
  ui.filterDebugTimeline({ level: "warn" });
  assert.equal(rowsText().length, 1);
  ui.filterDebugTimeline({ level: "trace", layer: "host", text: "WINDOW" });
  assert.deepEqual(rowsText().map((text) => text.split(" ")[3]), ["host.window.created"]);
  assert.equal(ui.debugState().timeline.shown, 1);
  assert.throws(() => ui.filterDebugTimeline({}), /timeline filter needs level, layer, text, event, surface, session, cid, from, to or context/);
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

test("the timeline filters by identifiers and time and shows context rows marked apart", async (t) => {
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
  });
  await ui.showDebugTimeline();
  ui.filterDebugTimeline({ surface: "none" });
  assert.equal(ui.debugState().timeline.shown, 0);
  ui.filterDebugTimeline({ surface: "", event: "window.created", context: "1" });
  assert.deepEqual(ui.debugState().timeline.shown, 1);
  assert.deepEqual(ui.debugState().timeline.lines, 3);
  const marks = [...document.querySelectorAll('[data-expose="core.debug.timeline.row"]')].map((row) => row.dataset.context ?? "match");
  assert.deepEqual(marks, ["true", "match", "true"]);
  ui.filterDebugTimeline({ context: "0", from: "1970-01-01T00:00:00.000030Z" });
  assert.equal(ui.debugState().timeline.shown, 0);
  ui.filterDebugTimeline({ from: "1970-01-01T00:00:00.000020Z", to: "1970-01-01T00:00:00.000020Z" });
  assert.equal(ui.debugState().timeline.shown, 1);
  assert.throws(() => ui.filterDebugTimeline({ context: "x" }), /timeline context must be decimal digits, found "x"/);
  assert.throws(() => ui.filterDebugTimeline({ colour: "red" }), /timeline filter has no member colour/);
  assert.equal(ui.debugState().timeline.context, "0");
});

test("every filter control of the timeline points to the filter command with its member and has a dom name", async (t) => {
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
  });
  await ui.showDebugTimeline();
  const controls = [...document.querySelectorAll(".dbg-card__timeline [data-set]")];
  assert.deepEqual(controls.map((el) => el.dataset.set).toSorted(), ["cid", "context", "event", "from", "layer", "level", "session", "surface", "text", "to"]);
  for (const el of controls) {
    assert.equal(el.dataset.command, "core.debug.timeline.filter");
    assert.equal(el.dataset.value, el.dataset.set);
    assert.equal(el.dataset.expose, `core.debug.timeline.${el.dataset.set}`);
  }
});

const savedTexts = () => {
  const saves = [];
  return { saves, saveText: async (request) => { saves.push(request); return { saved: "/chosen/timeline.txt" }; } };
};

test("rows are selected and unselected by index, and the status reports the count and the warning", async (t) => {
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
  });
  await ui.showDebugTimeline();
  assert.equal(ui.debugState().timeline.selected, 0);
  assert.equal(ui.debugState().timeline.warning, WARNING);
  ui.selectDebugRow(2, true);
  ui.selectDebugRow(2, true);
  ui.selectDebugRow(0, true);
  assert.equal(ui.debugState().timeline.selected, 2);
  const picks = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
  assert.equal(picks.length, 3);
  assert.deepEqual(picks.map((el) => el.closest("[data-selected]")?.dataset.selected ?? "none"), ["true", "false", "true"]);
  ui.selectDebugRow(2, false);
  assert.equal(ui.debugState().timeline.selected, 1);
  assert.throws(() => ui.selectDebugRow(3, true), /timeline row 3 is not one of the 3 rows/);
  assert.throws(() => ui.selectDebugRow(0, "yes"), /timeline selected must be a boolean, found "yes"/);
  assert.throws(() => ui.selectDebugRow(-1, true), /timeline row -1 is not one of the 3 rows/);
  const warning = document.querySelector('[data-expose="core.debug.timeline.warning"]');
  assert.equal(warning.textContent, ui.debugState().timeline.warning);
});

test("the selected rows are saved in timeline order as one text, and a cancelled save panel is not an error", async (t) => {
  const { saves, saveText } = savedTexts();
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
    saveText,
  });
  await ui.showDebugTimeline();
  ui.selectDebugRow(2, true);
  ui.selectDebugRow(1, true);
  ui.filterDebugTimeline({ level: "warn" });
  assert.deepEqual(await ui.saveDebugRows(), { saved: "/chosen/timeline.txt" });
  assert.equal(saves.length, 1);
  assert.match(saves[0].name, /^soksak-timeline-\d{8}T\d{6}Z\.txt$/);
  assert.deepEqual(saves[0].text.split("\n"), [
    "1970-01-01T00:00:00.000020Z debug host host.window.created window=w1",
    '1970-01-01T00:00:00.000030Z warn page page.call.slow name="windows.list"',
    "",
  ]);
  assert.deepEqual(ui.debugState().operation, { action: "save-rows", path: saves[0].name, state: "done" });
  assert.equal(ui.debugState().error, null);
});

test("a cancelled save panel leaves no error and an empty selection is refused with an error", async (t) => {
  const { ui, shown } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
    saveText: async () => ({ saved: null }),
  });
  await ui.showDebugTimeline();
  await assert.rejects(ui.saveDebugRows(), /no timeline row is selected/);
  assert.match(ui.debugState().error, /^save-rows: no timeline row is selected/);
  assert.equal(shown.at(-1).where, "debug");
  ui.selectDebugRow(0, true);
  assert.deepEqual(await ui.saveDebugRows(), { saved: null });
  assert.equal(ui.debugState().error, null);
  assert.equal(ui.debugState().operation.state, "done");
  ui.listDebugFiles();
  await assert.rejects(ui.saveDebugRows(), /the debug timeline is not shown/);
});

test("the select buttons and the save button of the timeline point to declared commands and have dom names", async (t) => {
  const { ui } = await openView(t, {
    entries: [entry("logs/host-a.jsonl")],
    read: async ({ path }) => ({ path, size: HOST.length, truncated: false, kind: "text", text: HOST }),
  });
  await ui.showDebugTimeline();
  const picks = [...document.querySelectorAll('[data-expose="core.debug.timeline.select"]')];
  assert.ok(picks.length > 0 && picks.every((el) => el.dataset.command === "core.debug.timeline.select"));
  assert.equal(document.querySelector('[data-expose="core.debug.timeline.save"]').dataset.command, "core.debug.timeline.save");
});
