// The state view of the debug view: the tree, the comparison, the status, the bound controls and the shown errors
// (docs/spec/debug.md). The host calls of each test are the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openDebugView } from "./support/debug-document.mjs";

const linesText = () => [...document.querySelectorAll('[data-expose="core.debug.state.line"]')].map((el) => el.textContent);
const diffText = () => [...document.querySelectorAll('[data-expose="core.debug.state.difference"]')].map((el) => el.textContent);
const shownError = () => document.querySelector('[data-error="debug"]');
const recordCalls = (wire) => wire.calls.filter((call) => call.name === "debugRecord");

test("debug status exposes exact host-owned captures while fixture input changes only the listing", async () => {
  const captures = ["/config/logs/captures/still-main-1/window.png", "/config/logs/captures/still-project-2/window.png"];
  const { ui, wire, close } = await openDebugView("debug-state-ui-captures");
  try {
    assert.deepEqual(ui.debugState().captures, captures);
    ui.setDebugFixtureEntries([{ path: "logs/fixture.log", size: 1, modified: 1 }]);
    await ui.openDebug();
    assert.equal(recordCalls(wire).length, 2, "the listing fixture must not suppress the real recording call");
    assert.deepEqual(ui.debugState().captures, captures);
    assert.deepEqual(ui.debugState().entries.map(entry => entry.path), ["logs/fixture.log"]);
  } finally {
    await close();
  }
  wire.finish();
});

test("a new debug record clears previous capture ownership when the host returns none or fails", async () => {
  const { ui, wire, close } = await openDebugView("debug-state-ui-captures-cleared");
  try {
    assert.deepEqual(ui.debugState().captures, ["/config/logs/captures/still-main-1/window.png"]);
    ui.closeDebug();
    await ui.openDebug();
    assert.deepEqual(ui.debugState().captures, []);
    ui.closeDebug();
    await ui.openDebug();
    assert.deepEqual(ui.debugState().captures, []);
    assert.match(ui.debugState().error, /record: recording failed/);
  } finally {
    await close();
  }
  wire.finish();
});

test("the file list holds the raw stderr and crash files with a view button, and a state button only on state files", async () => {
  const { ui, wire, close } = await openDebugView("debug-state-ui-file-list");
  try {
    const paths = ui.debugState().entries.map((entry) => entry.path);
    assert.ok(paths.includes("logs/host-a.stderr") && paths.includes("logs/host-a.crash"));
    const views = [...document.querySelectorAll('[data-expose="core.debug.view"]')].map((el) => JSON.parse(el.dataset.params).path);
    assert.ok(views.includes("logs/host-a.stderr") && views.includes("logs/host-a.crash"));
    const states = [...document.querySelectorAll('[data-expose="core.debug.state"]')].map((el) => JSON.parse(el.dataset.params).path);
    assert.deepEqual(states.toSorted(), ["logs/state-1.json", "logs/state-2.json"]);
    await ui.viewDebugFile("logs/host-a.crash");
    assert.equal(document.querySelector('[data-expose="core.debug.text"]').textContent, "fatal error\n");
  } finally {
    await close();
  }
  wire.finish();
});

test("a state file is shown as a tree and two state files are compared", async () => {
  const { ui, wire, close } = await openDebugView("debug-state-ui-compare");
  try {
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
  } finally {
    await close();
  }
  wire.finish();
});

test("a state file that is not a state or a comparison without a shown state is an error that is shown", async () => {
  const { ui, wire, close } = await openDebugView("debug-state-ui-errors");
  try {
    await assert.rejects(ui.compareDebugState("logs/state-2.json"), /the debug state is not shown/);
    await assert.rejects(ui.showDebugState("logs/state-3.json"), /logs\/state-3\.json: not a state object: \[1\]/);
    assert.equal(shownError().dataset.error, "debug");
    assert.match(shownError().textContent, /^state: logs\/state-3\.json: not a state object/);
    await assert.rejects(ui.showDebugState("logs/host-a.stderr"), /logs\/host-a\.stderr is not a state file/);
    await ui.showDebugState("logs/state-1.json");
    await assert.rejects(ui.compareDebugState("logs/state-9.json"), /logs\/state-9\.json is not a state file/);
  } finally {
    await close();
  }
  wire.finish();
});

test("every interactive element of the state view points to a declared command and has an element name", async () => {
  const { ui, wire, close } = await openDebugView("debug-state-ui-controls");
  try {
    await ui.showDebugState("logs/state-1.json");
    const controls = [...document.querySelectorAll(".dbg-card button, .dbg-card input, .dbg-card select")];
    assert.ok(controls.some((el) => el.dataset.command === "core.debug.state.compare"));
    for (const el of controls) {
      assert.ok(el.dataset.command, `${el.outerHTML} has no command`);
      assert.ok(el.dataset.expose, `${el.outerHTML} has no element name`);
    }
  } finally {
    await close();
  }
  wire.finish();
});
