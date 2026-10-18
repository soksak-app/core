import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The events of the memory saver, recorded through the emitter of the page.
const emitted = [];
const actualLog = await import("../page-log.js");
mock.module("../page-log.js", { exports: { ...actualLog, emitEvent: (level, event, fields) => emitted.push({ level, event, fields }) } });
const { createMemorySaver } = await import("../memory-saver.js");

const MINUTE = 60_000;
// Lets the awaited steps of an attempt run; the fakes resolve in microtasks.
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const pluginOf = (id) => (id.startsWith("u-") ? "undeclared" : id.startsWith("g-") ? "background" : "fixture");
const tabs = (...ids) => ids.map((id) => ({ id, plugin: pluginOf(id) }));
const named = (name) => emitted.filter((entry) => entry.event === name).map((entry) => entry.fields);

/** A saver over fakes at its declared dependencies, started before any tab; the clock is the mocked Date. */
function harness(options = {}) {
  emitted.length = 0;
  const state = { enabled: options.enabled ?? true, delay: 120, keeps: new Map(), kept: new Set(), commits: [] };
  const saver = createMemorySaver({
    now: () => Date.now(),
    enabled: () => state.enabled,
    delay: () => state.delay,
    declaration: (plugin) => ({ undeclared: "undeclared", background: "background" })[plugin] ?? "unload",
    keeps: (tab) => state.keeps.get(tab) ?? [],
    kept: (tab) => state.kept.has(tab),
    ...("regions" in options ? (options.regions ? { regions: options.regions } : {}) : { regions: async () => [] }),
    interaction: options.interaction ?? (async () => undefined),
    commit: options.commit ?? (async () => { state.commits.push(saver.place([]).unload); }),
    showLabel: () => {},
  });
  saver.start();
  return { saver, state };
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }));
test.afterEach(() => mock.timers.reset());

test("the delay unloads a hidden tab and a show restores it", async () => {
  const { saver, state } = harness();
  saver.observe(new Set(["a", "b"]), tabs("a", "b"));
  saver.observe(new Set(["b"]), tabs("a", "b"));
  mock.timers.tick(120 * MINUTE - 1);
  await settle();
  assert.equal(saver.unloaded("a"), false);
  mock.timers.tick(1);
  await settle();
  assert.equal(saver.unloaded("a"), true);
  assert.deepEqual(state.commits, [["a"]]);
  assert.deepEqual(named("page.tab.unloaded"), [{ tab: "a", plugin: "fixture", trigger: "delay" }]);
  saver.observe(new Set(["a"]), tabs("a", "b"));
  assert.equal(saver.unloaded("a"), false);
  assert.deepEqual(named("page.tab.restored"), [{ tab: "a", plugin: "fixture", history: false }]);
  assert.deepEqual(saver.place([{ id: "a" }, { id: "b" }]).surfaces.map((surface) => surface.id), ["a", "b"]);
});

/** Hides a tab from its first commit, lets two delays pass, and returns the reasons that keep it loaded. */
async function protectedBy(setup, options = {}) {
  const { saver, state } = harness(options);
  setup?.(state);
  const tab = options.tab ?? "a";
  saver.observe(new Set(["x"]), tabs("x", tab));
  for (let step = 0; step < 2; step++) {
    mock.timers.tick(120 * MINUTE);
    await settle();
  }
  assert.equal(saver.unloaded(tab), false);
  assert.deepEqual(named("page.tab.unloaded"), []);
  return saver.reasons(tab);
}

test("shown protects the shown tab", async () => {
  const { saver } = harness();
  saver.observe(new Set(["a"]), tabs("a"));
  mock.timers.tick(240 * MINUTE);
  await settle();
  assert.equal(saver.unloaded("a"), false);
  assert.deepEqual(saver.reasons("a"), ["shown"]);
});

test("recent protects a tab shown less than the delay ago", () => {
  const { saver } = harness();
  saver.observe(new Set(["a"]), tabs("a", "x"));
  mock.timers.tick(10 * MINUTE);
  saver.observe(new Set(["x"]), tabs("a", "x"));
  mock.timers.tick(100 * MINUTE);
  assert.deepEqual(saver.reasons("a"), ["recent"]);
});

test("keep:modified protects a tab", async () => {
  assert.deepEqual(await protectedBy((state) => state.keeps.set("a", ["keep:modified"])), ["keep:modified"]);
});

test("keep:busy protects a tab", async () => {
  assert.deepEqual(await protectedBy((state) => state.keeps.set("a", ["keep:busy"])), ["keep:busy"]);
});

test("kept protects a tab", async () => {
  assert.deepEqual(await protectedBy((state) => state.kept.add("a")), ["kept"]);
});

test("off protects every tab", async () => {
  assert.deepEqual(await protectedBy(null, { enabled: false }), ["off"]);
});

test("undeclared protects a tab of a plugin without surface.unload", async () => {
  assert.deepEqual(await protectedBy(null, { tab: "u-a" }), ["undeclared"]);
});

test("background protects a tab of a plugin with a background session", async () => {
  assert.deepEqual(await protectedBy(null, { tab: "g-a" }), ["background"]);
});

test("a media reply protects a tab and moves its deadline one delay later", async () => {
  let asked = 0;
  assert.deepEqual(await protectedBy(null, { regions: async () => { asked++; return ["media"]; } }), ["media"]);
  // The first deadline at 120 minutes and the next one at 240 minutes each asked the regions once.
  assert.equal(asked, 2);
});

test("capture and form replies protect a tab", async () => {
  assert.deepEqual(await protectedBy(null, { regions: async () => ["capture", "form"] }), ["capture", "form"]);
});

test("without a region query every hidden tab is protected by media-unknown", async () => {
  assert.deepEqual(await protectedBy(null, { regions: undefined }), ["media-unknown"]);
});

test("turning the setting on keeps the hidden time of each tab", async () => {
  const { saver, state } = harness({ enabled: false });
  saver.observe(new Set(["x"]), tabs("a", "x"));
  mock.timers.tick(100 * MINUTE);
  state.enabled = true;
  saver.settingsChanged();
  mock.timers.tick(20 * MINUTE - 1);
  await settle();
  assert.equal(saver.unloaded("a"), false);
  mock.timers.tick(1);
  await settle();
  assert.equal(saver.unloaded("a"), true);
});

test("a tab mounted without being shown takes its mount time as its hidden time", async () => {
  const { saver } = harness();
  saver.observe(new Set(["x"]), tabs("x"));
  mock.timers.tick(30 * MINUTE);
  saver.observe(new Set(["x"]), tabs("x", "a"));
  mock.timers.tick(120 * MINUTE - 1);
  await settle();
  assert.equal(saver.unloaded("a"), false);
  mock.timers.tick(1);
  await settle();
  assert.equal(saver.unloaded("a"), true);
});

test("one critical report unloads hidden tabs one at a time, least recently shown first, until a normal report", async () => {
  const gates = [];
  const { saver } = harness({ commit: () => new Promise((resolve) => gates.push(resolve)) });
  // a, b and c are shown in this order and then hidden; recent does not protect under pressure.
  for (const id of ["c", "a", "b", "d"]) {
    saver.observe(new Set([id]), tabs("a", "b", "c", "d"));
    mock.timers.tick(MINUTE);
  }
  saver.pressure({ level: "critical", seq: 1 });
  await settle();
  assert.equal(gates.length, 1);
  gates[0]();
  await settle();
  assert.equal(gates.length, 2);
  gates[1]();
  await settle();
  assert.equal(gates.length, 3);
  saver.pressure({ level: "normal", seq: 2 });
  gates[2]();
  await settle();
  assert.deepEqual(named("page.tab.unloaded").map((fields) => [fields.tab, fields.trigger]),
    [["c", "pressure"], ["a", "pressure"], ["b", "pressure"]]);
  assert.equal(saver.unloaded("d"), false);
  // A normal report stops the unloads of a later critical report after the unload in progress.
  saver.observe(new Set(["a"]), tabs("a", "b", "c", "d"));
  saver.observe(new Set(["b"]), tabs("a", "b", "c", "d"));
  saver.pressure({ level: "critical", seq: 3 });
  await settle();
  assert.equal(gates.length, 4);
  saver.pressure({ level: "normal", seq: 4 });
  gates[3]();
  await settle();
  assert.equal(gates.length, 4);
  assert.equal(named("page.tab.unloaded").length, 4);
});

test("a pressure report without a candidate is page.tab.unload.skipped", async () => {
  const { saver, state } = harness();
  state.keeps.set("a", ["keep:busy"]);
  saver.observe(new Set(["x"]), tabs("a", "x"));
  saver.pressure({ level: "warn", seq: 7 });
  await settle();
  assert.deepEqual(named("page.tab.unload.skipped"), [{ trigger: "pressure", seq: 7, reasons: ["shown", "keep:busy"] }]);
  assert.equal(saver.unloaded("a"), false);
});

for (const [name, interrupt, reasons] of [
  ["a show", (saver) => saver.observe(new Set(["a"]), tabs("a", "x")), ["shown"]],
  ["a show and a hide", (saver) => {
    saver.observe(new Set(["a"]), tabs("a", "x"));
    saver.observe(new Set(["x"]), tabs("a", "x"));
  }, ["shown"]],
  ["a modified report", (saver, state) => { state.keeps.set("a", ["keep:modified"]); saver.protectionsChanged(); }, ["keep:modified"]],
]) {
  test(`${name} during a pending awaited step leaves the tab loaded`, async () => {
    let release;
    const { saver, state } = harness({ interaction: () => new Promise((resolve) => { release = resolve; }) });
    saver.observe(new Set(["x"]), tabs("a", "x"));
    mock.timers.tick(120 * MINUTE);
    await settle();
    assert.equal(typeof release, "function");
    interrupt(saver, state);
    release(undefined);
    await settle();
    assert.equal(saver.unloaded("a"), false);
    assert.deepEqual(state.commits, []);
    assert.deepEqual(named("page.tab.unload.skipped"), [{ trigger: "delay", seq: 0, reasons }]);
  });
}

test("a commit after an unload neither declares the tab nor releases it as a closed tab", async () => {
  const { saver } = harness();
  saver.observe(new Set(["x"]), tabs("a", "x"));
  mock.timers.tick(120 * MINUTE);
  await settle();
  assert.equal(saver.unloaded("a"), true);
  const placed = saver.place([{ id: "x" }, { id: "a" }]);
  // The tab stays in the layout: it is among the retained surfaces, so the commit does not release it as a closed tab
  // (which forgets its reports), and it is not declared, so the host keeps no surface for it.
  assert.deepEqual(placed.surfaces.map((surface) => surface.id), ["x"]);
  assert.deepEqual([...placed.retain], ["x", "a"]);
  assert.deepEqual(placed.unload, ["a"]);
});

test("a restart with the setting on starts hidden declaring tabs unloaded with their cached label", () => {
  emitted.length = 0;
  const labels = [];
  const create = (enabled) => createMemorySaver({
    now: () => Date.now(), enabled: () => enabled, delay: () => 120,
    declaration: (plugin) => (plugin === "undeclared" ? "undeclared" : "unload"),
    keeps: () => [], kept: () => false, regions: async () => [], interaction: async () => undefined,
    commit: async () => {}, showLabel: (tab) => labels.push(tab),
  });
  const on = create(true);
  on.observe(new Set(["x"]), tabs("x", "a", "u-b"));
  on.start();
  assert.equal(on.unloaded("a"), true);
  assert.equal(on.unloaded("u-b"), false);
  assert.equal(on.unloaded("x"), false);
  assert.deepEqual(labels, ["a"]);
  assert.deepEqual(named("page.tab.unloaded"), []);
  const off = create(false);
  off.observe(new Set(["x"]), tabs("x", "a"));
  off.start();
  assert.equal(off.unloaded("a"), false);
});
