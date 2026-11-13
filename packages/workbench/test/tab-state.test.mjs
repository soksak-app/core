import assert from "node:assert/strict";
import test from "node:test";
import { checkTabStateDocument, openTabStates, tabStateCore } from "../tab-state.js";

// A store with the tabState and tabStatePut kinds of the workspace call (docs/spec/native-host.md), over one document.
function documentStore(document = null) {
  const store = {
    document,
    puts: [],
    tabState: async () => structuredClone(store.document),
    tabStatePut: async (tab, entry) => {
      store.puts.push({ tab, entry: structuredClone(entry) });
      store.document ??= { format: 1, tabs: {} };
      if (entry === null) delete store.document.tabs[tab];
      else store.document.tabs[tab] = structuredClone(entry);
      return JSON.stringify(store.document).length;
    },
  };
  return store;
}

function open(store, failures = []) {
  return openTabStates({
    store,
    failed: (error) => failures.push(error.message),
    // The plugin "declaring" declares surface.unload as {format, maxBytes}; "undeclared" declares false.
    unloadOf: (plugin) => (plugin === "declaring" ? { format: 1, maxBytes: 1024 } : false),
  });
}

test("a reader accepts format 1 and refuses another format with the file and the format found", async () => {
  assert.deepEqual(checkTabStateDocument(null), {});
  assert.deepEqual(checkTabStateDocument({ format: 1, tabs: { a: { kept: true } } }), { a: { kept: true } });
  assert.throws(() => checkTabStateDocument({ format: 2, tabs: {} }), { message: "tab-state.json: tab state format 2 is not 1" });
  assert.throws(() => checkTabStateDocument({ tabs: {} }), { message: "tab-state.json: tab state format missing is not 1" });
  await assert.rejects(open(documentStore({ format: 2, tabs: {} })), { message: "tab-state.json: tab state format 2 is not 1" });
});

test("writes of one tab are coalesced to one per second and each store write is an event", () => {
  const core = tabStateCore([]);
  core.change("tab-a", "state", { format: 1, value: 1 }, 0);
  core.change("tab-a", "state", { format: 1, value: 2 }, 0);
  core.change("tab-a", "kept", true, 0);
  core.change("tab-b", "state", { format: 1, value: 3 }, 0);
  assert.equal(core.deadline(), 1000, "the writes of a tab share the deadline one second after its first change");
  assert.deepEqual(core.due(999), [], "no write before one second");
  assert.deepEqual(core.entry("tab-a"), { state: { format: 1, value: 2 }, kept: true }, "memory holds the latest value");
  assert.deepEqual(core.due(1000), [
    { type: "write", tab: "tab-a", entry: { state: { format: 1, value: 2 }, kept: true } },
    { type: "write", tab: "tab-b", entry: { state: { format: 1, value: 3 } } },
  ]);
  assert.equal(core.deadline(), null, "no deadline is pending after the writes");
  assert.deepEqual(core.written("tab-a", 42), [
    { type: "event", level: "debug", event: "workbench.tab.state.stored", fields: { tab: "tab-a", bytes: 42 } },
  ]);
  core.change("tab-a", "kept", undefined, 1000);
  assert.deepEqual(core.due(2000), [{ type: "write", tab: "tab-a", entry: { state: { format: 1, value: 2 } } }]);
});

test("quit flushes the pending writes at once", async () => {
  const store = documentStore();
  const states = await open(store);
  states.write("tab-a", { format: 1, value: "x" });
  await states.flush();
  assert.deepEqual(store.puts, [{ tab: "tab-a", entry: { state: { format: 1, value: "x" } } }]);
  await states.flush();
  assert.equal(store.puts.length, 1, "the flushed write is not repeated");
  // The flush clears the pending write, so the instant of the coalesced write has nothing due.
  const core = tabStateCore([]);
  core.change("tab-a", "state", { format: 1, value: "x" }, 0);
  assert.deepEqual(core.flush(), [{ type: "write", tab: "tab-a", entry: { state: { format: 1, value: "x" } } }]);
  assert.deepEqual(core.due(1000), []);
  assert.equal(core.deadline(), null);
});

test("an entry is removed only after the layout write that drops its tab is confirmed", { timeout: 1000 }, async () => {
  const store = documentStore({ format: 1, tabs: { a: { kept: true }, b: { kept: true } } });
  const states = await open(store);
  // The layout write is a thenable: the await of removeAfter calls its then, which resolves parked, so the check
  // follows the point where removeAfter waits for the confirmation.
  let parked;
  const waiting = new Promise((resolve) => { parked = resolve; });
  let confirm;
  const layout = { then(resolve) { confirm = resolve; parked(); } };
  const removal = states.removeAfter(layout, ["a"]);
  await waiting;
  // The writes that were queued before the check are done, so a removal that did not wait for the confirmation is in store.puts.
  await states.flush();
  assert.deepEqual(store.puts, [], "nothing is removed before the layout write is confirmed");
  assert.deepEqual(states.entry("a"), { kept: true });
  confirm();
  await removal;
  assert.deepEqual(store.puts, [{ tab: "a", entry: null }]);
  assert.equal(states.entry("a"), null);
  const failures = [];
  const kept = await open(store, failures);
  await assert.rejects(kept.removeAfter(Promise.reject(new Error("layout write failed")), ["b"]), { message: "layout write failed" });
  assert.deepEqual(kept.entry("b"), { kept: true }, "a refused layout write removes no entry");
  assert.deepEqual(store.document.tabs, { b: { kept: true } });
});

test("load reconciliation removes each orphan entry with an event", async () => {
  const document = { format: 1, tabs: { a: { kept: true }, gone: { label: "x" }, lost: { kept: true },
    "spc-aaaaaa/left/files.tree": { state: { format: 1, value: {} } } } };
  const kept = new Set(["a", "b", "spc-aaaaaa/left/files.tree"]);
  const core = tabStateCore(Object.entries(document.tabs));
  const actions = core.reconcile((tab) => kept.has(tab));
  assert.deepEqual(actions.filter((action) => action.type === "event").map((action) => [action.level, action.event, action.fields]),
    [["info", "workbench.tab.state.orphan", { tab: "gone" }], ["info", "workbench.tab.state.orphan", { tab: "lost" }]]);
  assert.deepEqual(actions.filter((action) => action.type === "write").map((action) => [action.tab, action.entry]),
    [["gone", null], ["lost", null]]);
  assert.equal(core.entry("gone"), null);
  const store = documentStore(structuredClone(document));
  const states = await open(store);
  await states.reconcile((tab) => kept.has(tab));
  assert.deepEqual(Object.keys(store.document.tabs), ["a", "spc-aaaaaa/left/files.tree"]);
  assert.equal(states.entry("gone"), null);
});

test("the label cache keeps the label of a declaring plugin, removes it on null, and survives a restart", async () => {
  const store = documentStore();
  const states = await open(store);
  states.cacheLabel("tab-e", "declaring", "notes.md");
  states.cacheLabel("tab-s", "undeclared", "zsh");
  await states.flush();
  assert.deepEqual(store.document.tabs, { "tab-e": { label: "notes.md" } }, "an undeclared plugin caches no label");
  const restarted = await open(store);
  assert.equal(restarted.label("tab-e"), "notes.md");
  assert.equal(restarted.label("tab-s"), null);
  restarted.cacheLabel("tab-e", "declaring", null);
  await restarted.flush();
  assert.deepEqual(store.puts.at(-1), { tab: "tab-e", entry: null }, "an entry without fields is removed");
  assert.equal((await open(store)).label("tab-e"), null);
});

test("a failed store write is reported and the entry stays in memory", async () => {
  const store = documentStore();
  store.tabStatePut = async () => { throw new Error("disk full"); };
  const failures = [];
  const states = await open(store, failures);
  states.setKept("tab-a", true);
  await states.flush();
  assert.deepEqual(failures, ["tab state of tab-a: disk full"]);
  assert.deepEqual(states.entry("tab-a"), { kept: true });
});
