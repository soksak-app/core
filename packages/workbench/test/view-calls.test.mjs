// Checks the answers of the workbench to the call requests of a view (docs/spec/native-surfaces.md#view-surfaces). The tab state,
// the runtime handlers and the command runners are fakes, so the test runs without a host.
import assert from "node:assert/strict";
import test from "node:test";
import { answerViewCall, viewStopState } from "../view-calls.js";

// A shortcut table in the form of packages/workbench/shortcuts.json, with rows that hold while a view has keyboard focus and a
// row that does not.
const SHORTCUTS = [
  { key: "cmd+q", owner: "native menu", command: "framework role", menu: "app/quit", when: "Any focus" },
  { key: "cmd+k", owner: "workbench", command: "core.focus.set", menu: null, when: "The library is shown" },
  { key: "cmd+j", owner: "workbench", command: "core.probe.jump", menu: null, when: "Any focus" },
  { key: "Escape", owner: "view", command: "none", menu: null, when: "A plugin view has keyboard focus" },
];

function fakes() {
  const ran = { core: [], owned: [], writes: [], native: [], sidecar: [], clipboard: [], links: [], subscribed: [], declared: [],
    reports: [], log: [], textSize: [], settings: [], registered: [], errors: [], failed: [], events: [] };
  const item = (plugin, index) => Object.freeze({ plugin, index, item: { name: plugin }, module: `/modules/@scope/plugin-${plugin}/ui/${plugin}.js`,
    fail: (reason) => { ran.failed.push({ plugin, index, reason }); } });
  const options = {
    plugin: "probe",
    surface: "probe-surface",
    pending: new Map(),
    tab: {
      state: {
        read: () => ({ count: 2 }),
        write: (value) => { ran.writes.push(value); },
      },
      title: (text) => { ran.reports.push({ title: text }); },
      footer: (text) => { ran.reports.push({ footer: text }); },
      directory: (path) => { ran.reports.push({ directory: path }); },
      notify: (text, policy) => { ran.reports.push({ notify: text, policy }); },
      modified: (value) => { ran.reports.push({ modified: value }); },
      error: (text) => { ran.reports.push({ error: text }); },
      keep: (reason, on) => { ran.reports.push({ keep: reason, on }); },
    },
    contributions: (point) => {
      if (point !== "language") throw new Error(`extension point ${point} is not declared by probe`);
      return [item("one", 0), item("two", 1)];
    },
    shortcuts: SHORTCUTS,
    emitEvent: (level, event, fields) => { ran.events.push({ level, event, fields }); },
    runCore: async (name, params) => { ran.core.push({ name, params }); return { core: true }; },
    runOwned: async (name, params, owner) => { ran.owned.push({ name, params, owner }); return { owned: true }; },
    runtime: {
      native: { call: async (name, payload) => { ran.native.push({ name, payload }); return { native: true }; } },
      sidecar: { send: async (id, body, cids) => { ran.sidecar.push({ id, body, cids }); return { sidecar: true }; } },
      clipboard: {
        read: async (type) => { ran.clipboard.push({ read: type }); return "text value"; },
        writeText: async (text) => { ran.clipboard.push({ write: text }); },
      },
      links: { open: async (url) => { ran.links.push(url); } },
      report: (line) => { ran.errors.push(line); },
      subscribe: {
        native: async (name) => { ran.subscribed.push({ native: name }); return null; },
        sidecarMessage: async (id) => { ran.subscribed.push({ sidecarMessage: id }); return null; },
        sidecarFailure: async (id) => { ran.subscribed.push({ sidecarFailure: id }); return null; },
        textSize: async () => { ran.subscribed.push({ textSize: true }); return null; },
        settings: async () => { ran.subscribed.push({ settings: true }); return null; },
        logLevels: async () => { ran.subscribed.push({ logLevels: true }); return null; },
      },
      command: {
        register: async (name) => { ran.declared.push(name); return null; },
      },
      log: {
        ...Object.fromEntries(["error", "warn", "info", "debug", "trace"].map((level) => [level,
          (event, fields, options) => { ran.log.push({ level, event, fields, ...(options === undefined ? {} : { options }) }); }])),
        enabled: (level) => level === "error" || level === "warn",
      },
      textSize: {
        read: () => { ran.textSize.push("read"); return 1.5; },
        on: (listener) => { ran.textSize.push("on"); return () => {}; },
      },
      settings: {
        read: () => { ran.settings.push("read"); return { home: "https://example.test" }; },
        on: (listener) => { ran.settings.push("on"); return () => {}; },
      },
      exposure: {
        registered: async ({ kind, name }) => { ran.registered.push({ kind, name }); return null; },
      },
    },
  };
  return { ran, options };
}

test("a forwarded tab.state.read returns the tab state of its surface", async () => {
  const { options } = fakes();
  assert.deepEqual(await answerViewCall({ id: 1, command: "tab.state.read", params: null }, options), { count: 2 });
});

test("tab.state.read is refused when the surface declares no tab state", async () => {
  const { options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "tab.state.read", params: null }, { ...options, tab: null }), /tab state is not declared/);
  await assert.rejects(answerViewCall({ id: 2, command: "tab.state.read", params: null }, { ...options, tab: { ...options.tab, state: undefined } }), /tab state is not declared/);
});

test("a command of another plugin is refused and runs nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "other.run", params: {} }, options), /belongs to other, not probe/);
  assert.deepEqual(ran.owned, []);
  assert.deepEqual(ran.core, []);
});

test("a core command runs through runCore and a command of the plugin through runOwned", async () => {
  const { ran, options } = fakes();
  assert.deepEqual(await answerViewCall({ id: 1, command: "core.surface.open", params: { a: 1 } }, options), { core: true });
  assert.deepEqual(await answerViewCall({ id: 2, command: "probe.run", params: { b: 2 } }, options), { owned: true });
  assert.deepEqual(ran.core, [{ name: "core.surface.open", params: { a: 1 } }]);
  assert.deepEqual(ran.owned, [{ name: "probe.run", params: { b: 2 }, owner: "probe" }]);
});

test("a call request without an integer id is refused and runs nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ command: "core.surface.open", params: {} }, options), /has no integer id/);
  assert.deepEqual(ran.core, []);
});

test("tab.state.write stores the params as the tab state of its surface", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "tab.state.write", params: { page: 3 } }, options), null);
  assert.deepEqual(ran.writes, [{ page: 3 }]);
});

test("tab.state.write is refused when the surface declares no tab state", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "tab.state.write", params: {} }, { ...options, tab: null }), /tab state is not declared/);
  await assert.rejects(answerViewCall({ id: 2, command: "tab.state.write", params: {} }, { ...options, tab: { ...options.tab, state: undefined } }), /tab state is not declared/);
  assert.deepEqual(ran.writes, []);
});

test("runtime.native.call runs the host call of the surface with its name and payload", async () => {
  const { ran, options } = fakes();
  assert.deepEqual(await answerViewCall({ id: 1, command: "runtime.native.call", params: { name: "documentAttach", payload: { document: "a" } } }, options),
    { native: true });
  assert.deepEqual(ran.native, [{ name: "documentAttach", payload: { document: "a" } }]);
});

test("runtime.native.call refuses a missing or empty name and runs nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "runtime.native.call", params: { name: "" } }, options), /requires a non-empty name/);
  assert.deepEqual(ran.native, []);
});

test("runtime.sidecar.send sends the body with its correlation identifiers through the declared sidecar", async () => {
  const { ran, options } = fakes();
  assert.deepEqual(await answerViewCall({ id: 1, command: "runtime.sidecar.send", params: { id: "probe", body: { n: 1 }, cids: ["c1"] } }, options),
    { sidecar: true });
  assert.deepEqual(ran.sidecar, [{ id: "probe", body: { n: 1 }, cids: ["c1"] }]);
});

test("runtime.clipboard.read returns the text of the clipboard and refuses the png type", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.clipboard.read", params: "text" }, options), "text value");
  assert.deepEqual(ran.clipboard, [{ read: "text" }]);
  await assert.rejects(answerViewCall({ id: 2, command: "runtime.clipboard.read", params: "png" }, options), /runtime.clipboard.read png is not served/);
  assert.deepEqual(ran.clipboard, [{ read: "text" }]);
});

test("runtime.clipboard.writeText writes the text and replies null", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.clipboard.writeText", params: "hi" }, options), null);
  assert.deepEqual(ran.clipboard, [{ write: "hi" }]);
});

test("runtime.links.open opens the link of its params", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.links.open", params: "https://example.test" }, options), null);
  assert.deepEqual(ran.links, ["https://example.test"]);
});

test("the tab reports of a view reach the handlers of its surface and reply null", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "tab.title", params: "문서" }, options), null);
  assert.equal(await answerViewCall({ id: 2, command: "tab.footer", params: "1 of 3" }, options), null);
  assert.equal(await answerViewCall({ id: 3, command: "tab.directory", params: "/tmp" }, options), null);
  assert.equal(await answerViewCall({ id: 4, command: "tab.modified", params: true }, options), null);
  assert.equal(await answerViewCall({ id: 5, command: "tab.error", params: "저장하지 못했습니다" }, options), null);
  assert.deepEqual(ran.reports, [
    { title: "문서" }, { footer: "1 of 3" }, { directory: "/tmp" }, { modified: true }, { error: "저장하지 못했습니다" },
  ]);
});

test("tab.notify takes {text, policy} and tab.keep takes {reason, on} from the params", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "tab.notify", params: { text: "끝났습니다", policy: "system" } }, options), null);
  assert.equal(await answerViewCall({ id: 2, command: "tab.keep", params: { reason: "busy", on: true } }, options), null);
  assert.deepEqual(ran.reports, [{ notify: "끝났습니다", policy: "system" }, { keep: "busy", on: true }]);
});

test("tab.notify and tab.keep refuse params that are not the recorded objects and run nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "tab.notify", params: "끝났습니다" }, options), /requires an object/);
  await assert.rejects(answerViewCall({ id: 2, command: "tab.keep", params: null }, options), /requires an object/);
  assert.deepEqual(ran.reports, []);
});

test("runtime.log sends the record of the level through the writer of the page and replies null", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.log", params: { level: "info", event: "saved", fields: { n: 1 } } }, options), null);
  assert.deepEqual(ran.log, [{ level: "info", event: "saved", fields: { n: 1 } }]);
});

test("runtime.log passes the cids of the record to the writer of the page", async () => {
  const { ran, options } = fakes();
  await answerViewCall({ id: 1, command: "runtime.log", params: { level: "info", event: "saved", fields: { n: 1 }, cids: ["b.1"] } }, options);
  assert.deepEqual(ran.log, [{ level: "info", event: "saved", fields: { n: 1 }, options: { cids: ["b.1"] } }]);
});

test("runtime.log.levels registers the change subscription of the stored levels and replies with them", async () => {
  const { ran, options } = fakes();
  const result = await answerViewCall({ id: 1, command: "runtime.log.levels", params: null }, options).catch((error) => error);
  assert.deepEqual(result, ["error", "warn"]);
  assert.deepEqual(ran.subscribed, [{ logLevels: true }]);
});

test("runtime.log refuses a level that the writer does not serve and writes nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(
    answerViewCall({ id: 1, command: "runtime.log", params: { level: "loud", event: "saved", fields: {} } }, options),
    /log level must be one of error, warn, info, debug, trace/,
  );
  await assert.rejects(answerViewCall({ id: 2, command: "runtime.log", params: "info" }, options), /requires an object/);
  assert.deepEqual(ran.log, []);
});

test("runtime.error writes the error line of the view to the application log with its surface and replies null", async () => {
  const { ran, options } = fakes();
  const result = await answerViewCall({ id: 1, command: "runtime.error", params: { where: "save", text: "disk full" } }, options)
    .catch((error) => error);
  assert.equal(result, null);
  assert.deepEqual(ran.errors, ["surface probe-surface save: disk full"]);
});

test("runtime.error refuses a place or a text that the error line cannot carry and writes nothing", async () => {
  const { ran, options } = fakes();
  const call = (id, params) => answerViewCall({ id, command: "runtime.error", params }, options);
  await assert.rejects(call(1, "disk full"), /view call runtime\.error requires an object/);
  for (const [id, where] of [[2, ""], [3, "save: now"], [4, "save\nnow"], [5, 7]]) {
    await assert.rejects(call(id, { where, text: "disk full" }), /view call runtime\.error requires a non-empty where without a control character or ": "/);
  }
  for (const [id, text] of [[6, ""], [7, null]]) {
    await assert.rejects(call(id, { where: "save", text }), /view call runtime\.error requires a non-empty text/);
  }
  assert.deepEqual(ran.errors, []);
});

test("runtime.contributions returns the connected items of the point with their modules on the core root", async () => {
  const { options } = fakes();
  const result = await answerViewCall({ id: 1, command: "runtime.contributions", params: { point: "language" } }, options)
    .catch((error) => error);
  assert.deepEqual(result, [
    { plugin: "one", index: 0, item: { name: "one" }, module: "sok://core/modules/@scope/plugin-one/ui/one.js" },
    { plugin: "two", index: 1, item: { name: "two" }, module: "sok://core/modules/@scope/plugin-two/ui/two.js" },
  ]);
  await assert.rejects(answerViewCall({ id: 2, command: "runtime.contributions", params: { point: "format" } }, options),
    /extension point format is not declared by probe/);
});

test("runtime.contributions.fail makes the named connected item invalid with its reason and replies null", async () => {
  const { ran, options } = fakes();
  const params = { point: "language", plugin: "two", index: 1, reason: "extend is not a function" };
  const result = await answerViewCall({ id: 1, command: "runtime.contributions.fail", params }, options).catch((error) => error);
  assert.equal(result, null);
  assert.deepEqual(ran.failed, [{ plugin: "two", index: 1, reason: "extend is not a function" }]);
});

test("runtime.contributions.fail refuses an item that is not connected and a reason that is not text", async () => {
  const { ran, options } = fakes();
  const call = (id, params) => answerViewCall({ id, command: "runtime.contributions.fail", params }, options);
  await assert.rejects(call(1, { point: "language", plugin: "two", index: 0, reason: "broken" }),
    /view call runtime\.contributions\.fail: language has no connected item 0 of two/);
  await assert.rejects(call(2, { point: "language", plugin: "two", index: 1, reason: "" }),
    /view call runtime\.contributions\.fail requires a non-empty reason/);
  assert.deepEqual(ran.failed, []);
});

test("runtime.shortcuts.read returns the rows of the shortcut table that hold while a view has keyboard focus", async () => {
  const { options } = fakes();
  const result = await answerViewCall({ id: 1, command: "runtime.shortcuts.read", params: null }, options).catch((error) => error);
  assert.deepEqual(result, [
    { key: "cmd+q", owner: "native menu", command: "framework role" },
    { key: "cmd+j", owner: "workbench", command: "core.probe.jump" },
    { key: "Escape", owner: "view", command: "none" },
  ]);
});

test("runtime.shortcuts.missing writes page.view.shortcut-table-missing with the plugin at error level", async () => {
  const { ran, options } = fakes();
  const result = await answerViewCall({ id: 1, command: "runtime.shortcuts.missing", params: null }, options).catch((error) => error);
  assert.equal(result, null);
  assert.deepEqual(ran.events, [{ level: "error", event: "page.view.shortcut-table-missing", fields: { plugin: "probe" } }]);
});

test("runtime.shortcuts.run runs the command of a workbench row of the view table and refuses any other key", async () => {
  const { ran, options } = fakes();
  const result = await answerViewCall({ id: 1, command: "runtime.shortcuts.run", params: { key: "cmd+j" } }, options).catch((error) => error);
  assert.deepEqual(result, { core: true });
  assert.deepEqual(ran.core, [{ name: "core.probe.jump", params: {} }]);
  for (const [id, key] of [[2, "cmd+k"], [3, "cmd+q"], [4, "Escape"]]) {
    await assert.rejects(answerViewCall({ id, command: "runtime.shortcuts.run", params: { key } }, options),
      new RegExp(`view call runtime\\.shortcuts\\.run: ${key.replace("+", "\\+")} is not a workbench shortcut of a view`));
  }
  assert.equal(ran.core.length, 1);
});

test("a passed shortcut whose command fails writes page.input.shortcut.failed and replies with the error", async () => {
  const { ran, options } = fakes();
  options.runCore = async () => { throw new Error("no focus target"); };
  await assert.rejects(answerViewCall({ id: 1, command: "runtime.shortcuts.run", params: { key: "cmd+j" } }, options), /no focus target/);
  assert.deepEqual(ran.events, [{ level: "error", event: "page.input.shortcut.failed",
    fields: { plugin: "probe", key: "cmd+j", command: "core.probe.jump" } }]);
});

test("runtime.textSize.read returns the scale of the surface and runtime.textSize.on subscribes once", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.textSize.read", params: null }, options), 1.5);
  assert.equal(await answerViewCall({ id: 2, command: "runtime.textSize.on", params: null }, options), null);
  assert.deepEqual(ran.textSize, ["read"]);
  assert.deepEqual(ran.subscribed, [{ textSize: true }]);
});

test("runtime.settings.read returns the settings of the plugin and runtime.settings.on subscribes once", async () => {
  const { ran, options } = fakes();
  assert.deepEqual(await answerViewCall({ id: 1, command: "runtime.settings.read", params: null }, options), { home: "https://example.test" });
  assert.equal(await answerViewCall({ id: 2, command: "runtime.settings.on", params: null }, options), null);
  assert.deepEqual(ran.settings, ["read"]);
  assert.deepEqual(ran.subscribed, [{ settings: true }]);
});

test("a runtime or tab entry that the route does not serve is refused as not served", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "runtime.unknown.run", params: {} }, options), /runtime.unknown.run is not served/);
  assert.deepEqual(ran.core, []);
  assert.deepEqual(ran.owned, []);
});

test("a cancel ends the pending call, which replies cancelled, and the pending call is removed", async () => {
  const { options } = fakes();
  options.runtime.sidecar.send = () => new Promise(() => {});
  const call = answerViewCall({ id: 5, command: "runtime.sidecar.send", params: { id: "probe", body: 1, cids: [] } }, options);
  // The rejection is observed below; this handler only keeps a failed earlier step from being reported as unhandled.
  call.catch(() => {});
  assert.equal(options.pending.size, 1);
  assert.equal(await answerViewCall({ id: 5, cancel: true }, options), undefined);
  await assert.rejects(call, { message: "cancelled" });
  assert.equal(options.pending.size, 0);
});

test("a cancel of a call that has no pending call ends nothing", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 9, cancel: true }, options), undefined);
  assert.deepEqual(ran.core, []);
  assert.deepEqual(ran.owned, []);
  assert.equal(options.pending.size, 0);
});

test("a call whose id is pending is refused", async () => {
  const { options } = fakes();
  options.runtime.sidecar.send = () => new Promise(() => {});
  const first = answerViewCall({ id: 6, command: "runtime.sidecar.send", params: { id: "probe", body: 1, cids: [] } }, options);
  first.catch(() => {});
  await assert.rejects(answerViewCall({ id: 6, command: "runtime.links.open", params: "https://example.test" }, options), /view call 6 is already pending/);
  await answerViewCall({ id: 6, cancel: true }, options);
  await assert.rejects(first, { message: "cancelled" });
});

test("a subscription call of the view runs its page subscription and replies null", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.native.on", params: { name: "probe.changed" } }, options), null);
  assert.equal(await answerViewCall({ id: 2, command: "runtime.sidecar.on", params: { id: "probe" } }, options), null);
  assert.equal(await answerViewCall({ id: 3, command: "runtime.sidecar.onFailure", params: { id: "probe" } }, options), null);
  assert.deepEqual(ran.subscribed, [{ native: "probe.changed" }, { sidecarMessage: "probe" }, { sidecarFailure: "probe" }]);
});

test("a subscription call without its name or id is refused and subscribes to nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "runtime.native.on", params: { name: "" } }, options), /requires a non-empty name/);
  await assert.rejects(answerViewCall({ id: 2, command: "runtime.sidecar.on", params: null }, options), /requires an object/);
  await assert.rejects(answerViewCall({ id: 3, command: "runtime.sidecar.onFailure", params: { id: 7 } }, options), /requires a non-empty id/);
  assert.deepEqual(ran.subscribed, []);
});

test("runtime.theme is refused as a call, because the theme reaches a view as a host message", async () => {
  const { options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "runtime.theme", params: null }, options), /view call runtime.theme is not served/);
});

test("a registration call of the view declares its command on the page and replies null", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.command.register", params: { name: "probe.run" } }, options), null);
  assert.deepEqual(ran.declared, ["probe.run"]);
});

test("a registration call without a name is refused and declares nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "runtime.command.register", params: { name: "" } }, options), /requires a non-empty name/);
  await assert.rejects(answerViewCall({ id: 2, command: "runtime.command.register", params: "probe.run" }, options), /requires an object/);
  assert.deepEqual(ran.declared, []);
});

test("a registered call of the view records the status or dom of its surface", async () => {
  const { ran, options } = fakes();
  assert.equal(await answerViewCall({ id: 1, command: "runtime.native.call", params: { name: "registered", payload: { kind: "status", name: "probe.state" } } }, options), null);
  assert.equal(await answerViewCall({ id: 2, command: "runtime.native.call", params: { name: "registered", payload: { kind: "dom", name: "probe.view" } } }, options), null);
  assert.deepEqual(ran.registered, [{ kind: "status", name: "probe.state" }, { kind: "dom", name: "probe.view" }]);
  assert.deepEqual(ran.native.filter(({ name }) => name === "registered"), [], "the registration was forwarded to the host call route");
});

test("a registered call without its kind or name is refused and records nothing", async () => {
  const { ran, options } = fakes();
  await assert.rejects(answerViewCall({ id: 1, command: "runtime.native.call", params: { name: "registered", payload: "probe.state" } }, options), /requires an object/);
  await assert.rejects(answerViewCall({ id: 2, command: "runtime.native.call", params: { name: "registered", payload: { kind: "", name: "probe.state" } } }, options), /requires a non-empty kind/);
  await assert.rejects(answerViewCall({ id: 3, command: "runtime.native.call", params: { name: "registered", payload: { kind: "status" } } }, options), /requires a non-empty name/);
  assert.deepEqual(ran.registered, []);
});

// contract: view.restart.limit-shows-error
test("a view-stopped event becomes the error state of its surface with its reason", () => {
  const state = viewStopState({ surface: "probe-surface", plugin: "probe", reason: "the view failed 4 times within 300 seconds" });
  assert.equal(state.phase, "error");
  assert.equal(state.error.message, "the view failed 4 times within 300 seconds");
});

// contract: view.restart.limit-shows-error
test("a view-stopped event without a reason is refused", () => {
  assert.throws(() => viewStopState({ surface: "probe-surface", plugin: "probe" }), /has no reason/);
});

// contract: view.restart.restores-state
// The workbench keys the tab state by surface, so a view that is created again on the same surface reads the state that was saved before
// the restart. The restarted view has a new pending map, and the tab state of the surface is the same object.
test("a restarted view reads the tab state of its surface as it was saved before the restart", async () => {
  const store = new Map();
  const surfaceTab = {
    read: () => store.get("probe-surface") ?? null,
    write: (value) => { store.set("probe-surface", value); },
  };
  const { options: before } = fakes();
  await answerViewCall({ id: 1, command: "tab.state.write", params: { page: 3 } }, { ...before, tab: { ...before.tab, state: surfaceTab } });
  assert.deepEqual(store.get("probe-surface"), { page: 3 });
  const { options: restarted } = fakes();
  assert.deepEqual(
    await answerViewCall({ id: 1, command: "tab.state.read", params: null }, { ...restarted, tab: { ...restarted.tab, state: surfaceTab } }),
    { page: 3 },
  );
});
