// The state view of the debug view: the tree, the comparison, the status, the bound controls and the shown errors
// (docs/spec/debug.md).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const state = (core, modal) => JSON.stringify({ time: "t", host: "tauriv2", versions: { core }, windows: [], workbench: { modal } });
const FILES = {
  "logs/state-1.json": state("0.0.10", null),
  "logs/state-2.json": state("0.0.11", "debug"),
  "logs/host-a.stderr": "panic: x\n",
  "logs/host-a.crash": "fatal error\n",
};

async function openView(t, files = FILES, record = async () => ({ path: "logs/state-2.json" })) {
  const dom = new JSDOM("<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  globalThis.CSS = { escape: (value) => value };
  const shown = [];
  t.mock.module("../host.js", { namedExports: {
    native: false,
    debug: {
      record,
      files: async () => Object.entries(files).map(([path, text]) => ({ path, size: text.length, modified: 1 })),
      read: async ({ path }) => {
        if (!(path in files)) throw new Error(`debug: ${path} is not a file`);
        return { path, size: files[path].length, truncated: false, kind: "text", text: files[path] };
      },
      save: async () => {},
      saveAll: async () => {}, onSaveProgress: () => Promise.resolve(() => {}), onSaveDone: () => Promise.resolve(() => {}),
      onChanged: () => Promise.resolve(() => {}),
    },
    overlay: { show: () => {}, update: () => {}, place: () => {}, hide: () => {} },
  } });
  t.mock.module("../compositor.js", { namedExports: { standIn: () => {} } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  t.mock.module("../commands.js", { namedExports: {
    commandOf: () => null,
    delegate: () => {},
    mark: (el, name, params, valueName) => {
      el.dataset.command = name;
      el.dataset.params = JSON.stringify(params);
      if (valueName) el.dataset.value = valueName;
    },
    run: async () => {},
  } });
  t.mock.module("../exposure.js", { namedExports: { registry: { list: () => ({ status: [] }), registrants: () => [], handle: async () => ({}) } } });
  t.mock.module("../shown-errors.js", { namedExports: {
    hideError: () => {},
    showError: (element, where, text) => { element.textContent = text; shown.push({ where, text }); },
  } });
  const ui = await import(`../debug-ui.js?state-${Math.random()}`);
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  await ui.openDebug();
  t.after(() => { ui.closeDebug(); dom.window.close(); });
  return { ui, shown };
}

const linesText = () => [...document.querySelectorAll('[data-expose="core.debug.state.line"]')].map((el) => el.textContent);
const diffText = () => [...document.querySelectorAll('[data-expose="core.debug.state.difference"]')].map((el) => el.textContent);

test("debug status exposes exact host-owned captures while fixture input changes only the listing", async t => {
  const captures = ["/config/logs/captures/still-main-1/window.png", "/config/logs/captures/still-project-2/window.png"];
  let calls = 0;
  const { ui } = await openView(t, FILES, async () => { calls++; return { path: "logs/state-2.json", captures }; });
  assert.deepEqual(ui.debugState().captures, captures);
  ui.setDebugFixtureEntries([{ path: "logs/fixture.log", size: 1, modified: 1 }]);
  await ui.openDebug();
  assert.equal(calls, 2, "the listing fixture must not suppress the real recording call");
  assert.deepEqual(ui.debugState().captures, captures);
  assert.deepEqual(ui.debugState().entries.map(entry => entry.path), ["logs/fixture.log"]);
});

test("a new debug record clears previous capture ownership when the host returns none or fails", async t => {
  let reply = { path: "logs/state-2.json", captures: ["/config/logs/captures/still-main-1/window.png"] };
  const { ui } = await openView(t, FILES, async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  assert.deepEqual(ui.debugState().captures, reply.captures);
  ui.closeDebug();
  reply = { path: "logs/state-2.json" };
  await ui.openDebug();
  assert.deepEqual(ui.debugState().captures, []);
  ui.closeDebug();
  reply = new Error("recording failed");
  await ui.openDebug();
  assert.deepEqual(ui.debugState().captures, []);
  assert.match(ui.debugState().error, /record: recording failed/);
});

test("the file list holds the raw stderr and crash files with a view button, and a state button only on state files", async (t) => {
  const { ui } = await openView(t);
  const paths = ui.debugState().entries.map((entry) => entry.path);
  assert.ok(paths.includes("logs/host-a.stderr") && paths.includes("logs/host-a.crash"));
  const views = [...document.querySelectorAll('[data-expose="core.debug.view"]')].map((el) => JSON.parse(el.dataset.params).path);
  assert.ok(views.includes("logs/host-a.stderr") && views.includes("logs/host-a.crash"));
  const states = [...document.querySelectorAll('[data-expose="core.debug.state"]')].map((el) => JSON.parse(el.dataset.params).path);
  assert.deepEqual(states.toSorted(), ["logs/state-1.json", "logs/state-2.json"]);
  await ui.viewDebugFile("logs/host-a.crash");
  assert.equal(document.querySelector('[data-expose="core.debug.text"]').textContent, "fatal error\n");
});

test("a state file is shown as a tree and two state files are compared", async (t) => {
  const { ui } = await openView(t);
  await ui.showDebugState("logs/state-1.json");
  assert.ok(linesText().some((line) => line.endsWith('core: "0.0.10"')));
  assert.deepEqual(ui.debugState().state, { path: "logs/state-1.json", lines: 7, with: null, differences: 0 });
  assert.equal(ui.debugState().viewing, null);
  await ui.compareDebugState("logs/state-2.json");
  assert.deepEqual(diffText(), ['versions.core: "0.0.10" -> "0.0.11"', 'workbench.modal: null -> "debug"']);
  assert.deepEqual(ui.debugState().state, { path: "logs/state-1.json", lines: 7, with: "logs/state-2.json", differences: 2 });
  const select = document.querySelector('[data-expose="core.debug.state.with"]');
  assert.equal(select.dataset.command, "core.debug.state.compare");
  assert.equal(select.dataset.value, "with");
  assert.deepEqual([...select.options].map((option) => option.value), ["", "logs/state-2.json"]);
  await ui.compareDebugState("");
  assert.equal(ui.debugState().state.with, null);
  assert.deepEqual(diffText(), []);
  ui.listDebugFiles();
  assert.equal(ui.debugState().state, null);
});

test("a state file that is not a state or a comparison without a shown state is an error that is shown", async (t) => {
  const { ui, shown } = await openView(t, { ...FILES, "logs/state-3.json": "[1]" });
  await assert.rejects(ui.compareDebugState("logs/state-2.json"), /the debug state is not shown/);
  await assert.rejects(ui.showDebugState("logs/state-3.json"), /logs\/state-3\.json: not a state object: \[1\]/);
  assert.equal(shown.at(-1).where, "debug");
  assert.match(shown.at(-1).text, /^state: logs\/state-3\.json: not a state object/);
  await assert.rejects(ui.showDebugState("logs/host-a.stderr"), /logs\/host-a\.stderr is not a state file/);
  await ui.showDebugState("logs/state-1.json");
  await assert.rejects(ui.compareDebugState("logs/state-9.json"), /logs\/state-9\.json is not a state file/);
});

test("every interactive element of the state view points to a declared command and has an element name", async (t) => {
  const { ui } = await openView(t);
  await ui.showDebugState("logs/state-1.json");
  const controls = [...document.querySelectorAll(".dbg-card button, .dbg-card input, .dbg-card select")];
  assert.ok(controls.some((el) => el.dataset.command === "core.debug.state.compare"));
  for (const el of controls) {
    assert.ok(el.dataset.command, `${el.outerHTML} has no command`);
    assert.ok(el.dataset.expose, `${el.outerHTML} has no element name`);
  }
});
