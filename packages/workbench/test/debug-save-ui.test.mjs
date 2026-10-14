// The save of the logs folder in the debug view (docs/spec/debug.md): the host answers when the person chose the place and
// writes the tar on its own thread; the view shows the progress that the host reports, shows the button disabled, and
// refuses a second save while one writes.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

async function openView(t, answer = { saved: "/d/soksak.tar.gz", total: 3000 }) {
  const dom = new JSDOM("<body><div id=plane></div></body>");
  globalThis.document = dom.window.document;
  globalThis.CSS = { escape: (value) => value };
  const listeners = { progress: [], done: [] };
  t.mock.module("../host.js", { namedExports: {
    native: true,
    debug: {
      record: async () => ({ path: "logs/state-1.json" }),
      files: async () => [],
      read: async () => ({}),
      save: async () => {},
      saveAll: async () => answer,
      onChanged: () => Promise.resolve(() => {}),
      onSaveProgress: (listener) => { listeners.progress.push(listener); return Promise.resolve(() => {}); },
      onSaveDone: (listener) => { listeners.done.push(listener); return Promise.resolve(() => {}); },
    },
    overlay: { show: () => {}, update: () => {}, place: () => {}, hide: () => {} },
  } });
  t.mock.module("../compositor.js", { namedExports: { standIn: () => {} } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  t.mock.module("../commands.js", { namedExports: { commandOf: () => null, delegate: () => {}, mark: () => {}, run: async () => {} } });
  t.mock.module("../exposure.js", { namedExports: { registry: { list: () => ({ status: [] }), registrants: () => [], handle: async () => ({}) } } });
  t.mock.module("../shown-errors.js", { namedExports: { hideError: () => {}, showError: () => {} } });
  const ui = await import(`../debug-ui.js?save-${Math.random()}`);
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0 });
  await ui.openDebug();
  t.after(() => { ui.closeDebug(); dom.window.close(); });
  const tell = (kind, body) => { for (const listener of listeners[kind]) listener(body); };
  return { ui, tell };
}

const progressBar = () => document.querySelector('[data-expose="core.debug.progress"]');
const saveButton = () => document.querySelector('[data-key="save-all"]');

test("a save shows the progress that the host reports, shows the button disabled, and ends with the done event", async (t) => {
  const { ui, tell } = await openView(t);
  assert.deepEqual(await ui.saveDebugFiles(), { saved: "/d/soksak.tar.gz", total: 3000 });
  assert.deepEqual(ui.debugState().operation, { action: "save-all", path: "/d/soksak.tar.gz", state: "running", written: 0, total: 3000 });
  assert.equal(progressBar().closest(".dbg-card__progress").hidden, false, "the progress bar is hidden while the save runs");
  assert.equal(saveButton().disabled, true, "the button of the save is not disabled while the save runs");
  tell("progress", { saved: "/d/soksak.tar.gz", written: 1500, total: 3000 });
  assert.equal(ui.debugState().operation.written, 1500);
  assert.equal(progressBar().value, 1500);
  assert.equal(progressBar().max, 3000);
  tell("done", { saved: "/d/soksak.tar.gz", error: null });
  assert.deepEqual(ui.debugState().operation, { action: "save-all", path: "/d/soksak.tar.gz", state: "done", written: 3000, total: 3000 });
  assert.equal(progressBar().closest(".dbg-card__progress").hidden, true);
  assert.equal(saveButton().disabled, false);
});

test("a save while one writes is refused and shown, and a failure of the write is shown", async (t) => {
  const { ui, tell } = await openView(t);
  await ui.saveDebugFiles();
  await assert.rejects(ui.saveDebugFiles(), /debug: a save of the logs folder is running: \/d\/soksak\.tar\.gz/);
  assert.match(ui.debugState().error, /a save of the logs folder is running/);
  tell("done", { saved: "/d/soksak.tar.gz", error: "debug: logs/host-1.jsonl: disk full" });
  assert.equal(ui.debugState().operation.state, "failed");
  assert.match(ui.debugState().error, /disk full/);
});

test("a cancelled save panel ends the operation without a progress bar", async (t) => {
  const { ui } = await openView(t, { saved: null, total: 0 });
  assert.deepEqual(await ui.saveDebugFiles(), { saved: null, total: 0 });
  assert.deepEqual(ui.debugState().operation, { action: "save-all", path: null, state: "done" });
  assert.equal(progressBar().closest(".dbg-card__progress").hidden, true);
  assert.equal(saveButton().disabled, false);
});
