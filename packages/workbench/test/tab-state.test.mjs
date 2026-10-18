import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The events of the store, recorded through the emitter of the page.
const emitted = [];
const actualLog = await import("../page-log.js");
mock.module("../page-log.js", { exports: { ...actualLog, emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
const { checkTabStateDocument, openTabStates } = await import("../tab-state.js");

// A store with the tabState and tabStatePut kinds of the workspace call (docs/spec/native-host.md), over one document.
function fakeStore(document = null) {
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
  emitted.length = 0;
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
  await assert.rejects(open(fakeStore({ format: 2, tabs: {} })), { message: "tab-state.json: tab state format 2 is not 1" });
});

test("writes of one tab are coalesced to one per second and each store write is an event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = fakeStore();
  const events = emitted;
  const states = await open(store);
  states.write("tab-a", { format: 1, value: 1 });
  states.write("tab-a", { format: 1, value: 2 });
  states.setKept("tab-a", true);
  states.write("tab-b", { format: 1, value: 3 });
  assert.deepEqual(store.puts, [], "no write before one second");
  assert.deepEqual(states.entry("tab-a"), { state: { format: 1, value: 2 }, kept: true }, "memory holds the latest value");
  t.mock.timers.tick(999);
  await states.idle();
  assert.deepEqual(store.puts, []);
  t.mock.timers.tick(1);
  await states.idle();
  assert.deepEqual(store.puts, [
    { tab: "tab-a", entry: { state: { format: 1, value: 2 }, kept: true } },
    { tab: "tab-b", entry: { state: { format: 1, value: 3 } } },
  ]);
  assert.deepEqual(events.map((e) => [e.level, e.event, e.fields.tab, typeof e.fields.bytes]), [
    ["debug", "page.tab.state.stored", "tab-a", "number"],
    ["debug", "page.tab.state.stored", "tab-b", "number"],
  ]);
  states.setKept("tab-a", false);
  t.mock.timers.tick(1000);
  await states.idle();
  assert.deepEqual(store.puts.at(-1), { tab: "tab-a", entry: { state: { format: 1, value: 2 } } });
});

test("quit flushes the pending writes at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = fakeStore();
  const states = await open(store);
  states.write("tab-a", { format: 1, value: "x" });
  await states.flush();
  assert.deepEqual(store.puts, [{ tab: "tab-a", entry: { state: { format: 1, value: "x" } } }]);
  t.mock.timers.tick(1000);
  await states.idle();
  assert.equal(store.puts.length, 1, "the flushed write is not repeated");
});

test("an entry is removed only after the layout write that drops its tab is confirmed", async () => {
  const store = fakeStore({ format: 1, tabs: { a: { kept: true }, b: { kept: true } } });
  const states = await open(store);
  let confirm;
  const layout = new Promise((resolve) => { confirm = resolve; });
  const removal = states.removeAfter(layout, ["a"]);
  await new Promise((resolve) => setImmediate(resolve));
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
  const store = fakeStore({ format: 1, tabs: { a: { kept: true }, gone: { label: "x" }, lost: { kept: true } } });
  const events = emitted;
  const states = await open(store);
  await states.reconcile(new Set(["a", "b"]));
  assert.deepEqual(Object.keys(store.document.tabs), ["a"]);
  assert.deepEqual(events.filter((e) => e.event === "page.tab.state.orphan").map((e) => [e.level, e.fields]),
    [["info", { tab: "gone" }], ["info", { tab: "lost" }]]);
  assert.equal(states.entry("gone"), null);
});

test("the label cache keeps the label of a declaring plugin, removes it on null, and survives a restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = fakeStore();
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
  const store = fakeStore();
  store.tabStatePut = async () => { throw new Error("disk full"); };
  const failures = [];
  const states = await open(store, failures);
  states.setKept("tab-a", true);
  await states.flush();
  assert.deepEqual(failures, ["tab state of tab-a: disk full"]);
  assert.deepEqual(states.entry("tab-a"), { kept: true });
});
