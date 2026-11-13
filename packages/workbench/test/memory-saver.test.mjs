import assert from "node:assert/strict";
import test from "node:test";
import { memorySaverCore } from "../memory-saver.js";
import { memoryPlacement } from "../memory-placement.js";

const MINUTE = 60_000;
const START = 1_000_000;
const pluginOf = (id) => (id.startsWith("u-") ? "undeclared" : id.startsWith("g-") ? "background" : "fixture");
const tabs = (...ids) => ids.map((id) => ({ id, plugin: pluginOf(id), kind: "tab" }));
const declarationOf = ({ plugin }) => ({ undeclared: "undeclared", background: "background" })[plugin] ?? "unload";

/**
 * A harness over memorySaverCore. The time, the settings and the marks are data that the harness owns: s.at is the monotonic
 * time, and the input of each call is read from s. Every returned action is recorded in order. The awaited steps (regions,
 * interaction and commit) wait for their replies: settle answers the pending steps with the reply of the case, and a case that
 * holds a step answers it by hand with release.
 */
function harness(options = {}) {
  const s = { at: START, enabled: options.enabled ?? true, delay: 120, keeps: new Map(), kept: new Set() };
  const core = memorySaverCore({ declaration: options.declaration ?? declarationOf });
  const replies = {
    regions: options.regions ?? (() => ({ regions: [] })),
    interaction: options.interaction ?? (() => ({})),
    commit: options.commit ?? (() => ({})),
  };
  const input = () => ({ at: s.at, enabled: s.enabled, delay: s.delay, keeps: s.keeps, kept: s.kept });
  const h = {
    s, core, input,
    events: [], commits: [], states: [], failures: [], restores: [], labels: [], changes: 0, pending: [], settled: new Map(),
  };
  let nextRequest = 1;
  const named = (name) => h.events.filter((entry) => entry.event === name).map((entry) => entry.fields);
  h.named = named;

  function run(actions) {
    for (const action of actions) {
      switch (action.type) {
        case "changed": h.changes++; break;
        case "state": h.states.push([action.tab, action.state]); break;
        case "event": h.events.push({ level: action.level, event: action.event, fields: action.fields }); break;
        case "failed": h.failures.push(action.text); break;
        case "restore": h.restores.push(action.tab); break;
        case "showLabel": h.labels.push(action.tab); break;
        case "setKept":
          if (action.on) s.kept.add(action.tab);
          else s.kept.delete(action.tab);
          break;
        case "regions":
        case "interaction":
          h.pending.push(action);
          break;
        case "commit":
          h.commits.push(core.place([]).unload);
          if (action.attempt) h.pending.push(action);
          else if (action.retry) {
            const reply = replies.commit();
            if (reply.error) h.failures.push(`memory saver: tab ${action.retry}: commit failed: ${reply.error.message}`);
          } else {
            // The classification commit has no answer that the test models: a failure of it would be reported by the page.
            if (replies.commit().error) throw new Error("the classification commit refused is not modeled by the harness");
          }
          break;
        case "settled": h.settled.set(action.request, action.error); break;
        default: throw new Error(`unexpected action ${action.type}`);
      }
    }
  }

  const answer = (action) => run(core.answer(action.attempt, replies[action.type](action.tab), input()));

  /** Answers the pending steps whose type is in types, in order, until none of them waits. */
  h.settle = (types = ["regions", "interaction", "commit"]) => {
    for (;;) {
      const index = h.pending.findIndex((action) => types.includes(action.type));
      if (index < 0) return;
      const [action] = h.pending.splice(index, 1);
      answer(action);
    }
  };
  /** Answers the first pending step of the type with its reply of the case. */
  h.release = (type) => {
    const index = h.pending.findIndex((action) => action.type === type);
    if (index < 0) throw new Error(`no pending ${type} step`);
    const [action] = h.pending.splice(index, 1);
    answer(action);
  };
  /** Advances the time by ms, running the deadline when it falls within the advance, then answers the steps of the case. */
  h.tick = (ms) => {
    const end = s.at + ms;
    const due = core.deadline();
    if (due !== null && due <= end) {
      s.at = Math.max(s.at, due);
      run(core.fire(input()));
    }
    s.at = end;
    h.settle();
  };
  h.observe = (shown, list) => run(core.observe(shown, list, input()));
  h.classify = () => run(core.classify(input()));
  h.pressure = (report) => run(core.pressure(report, input()));
  h.settingsChanged = () => run(core.settingsChanged(input()));
  h.protectionsChanged = () => run(core.protectionsChanged(input()));
  h.keep = (tab, on) => run(core.keep(tab, on, input()));
  h.unload = (tab) => {
    const request = nextRequest++;
    run(core.unload(tab, request, input()));
    return request;
  };
  h.restored = (tab, history) => run(core.restored(tab, history, input()));
  h.restoreFailed = (tab, reason) => run(core.restoreFailed(tab, reason, input()));
  h.historyRefused = (tab, plugin, reason) => run(core.historyRefused(tab, plugin, reason, input()));
  h.status = () => core.status(input());
  h.reasons = (tab) => core.reasons(tab, input());
  h.state = (tab) => core.state(tab);
  h.unloaded = (tab) => core.unloaded(tab);
  h.place = (surfaces) => core.place(surfaces);
  h.fire = () => run(core.fire(input()));

  if (options.start !== false) h.classify();
  return h;
}

/** Hides a tab from its first commit, lets two delays pass, and returns the reasons that keep it loaded. */
function protectedBy(setup, options = {}) {
  const h = harness(options);
  setup?.(h.s);
  const tab = options.tab ?? "a";
  h.observe(new Set(["x"]), tabs("x", tab));
  for (let step = 0; step < 2; step++) h.tick(120 * MINUTE);
  assert.equal(h.unloaded(tab), false);
  assert.deepEqual(h.named("workbench.tab.unloaded"), []);
  return h.reasons(tab);
}

test("the delay unloads a hidden tab and a show restores it", () => {
  const h = harness();
  h.observe(new Set(["a", "b"]), tabs("a", "b"));
  h.observe(new Set(["b"]), tabs("a", "b"));
  h.tick(120 * MINUTE - 1);
  assert.equal(h.unloaded("a"), false);
  h.tick(1);
  assert.equal(h.unloaded("a"), true);
  assert.deepEqual(h.commits, [["a"]]);
  assert.deepEqual(h.named("workbench.tab.unloaded"), [{ tab: "a", plugin: "fixture", trigger: "delay" }]);
  h.observe(new Set(["a"]), tabs("a", "b"));
  assert.equal(h.unloaded("a"), false);
  assert.equal(h.state("a"), "restoring");
  h.restored("a", false);
  assert.equal(h.state("a"), "loaded");
  assert.deepEqual(h.named("workbench.tab.restored"), [{ tab: "a", plugin: "fixture", history: false }]);
  assert.deepEqual(h.place([{ id: "a" }, { id: "b" }]).surfaces.map((surface) => surface.id), ["a", "b"]);
});

test("shown protects the shown tab", () => {
  const h = harness();
  h.observe(new Set(["a"]), tabs("a"));
  h.tick(240 * MINUTE);
  assert.equal(h.unloaded("a"), false);
  assert.deepEqual(h.reasons("a"), ["shown"]);
});

test("recent protects a tab shown less than the delay ago", () => {
  const h = harness();
  h.observe(new Set(["a"]), tabs("a", "x"));
  h.tick(10 * MINUTE);
  h.observe(new Set(["x"]), tabs("a", "x"));
  h.tick(100 * MINUTE);
  assert.deepEqual(h.reasons("a"), ["recent"]);
});

test("keep:modified protects a tab", () => {
  assert.deepEqual(protectedBy((state) => state.keeps.set("a", ["keep:modified"])), ["keep:modified"]);
});

test("keep:busy protects a tab", () => {
  assert.deepEqual(protectedBy((state) => state.keeps.set("a", ["keep:busy"])), ["keep:busy"]);
});

test("kept protects a tab", () => {
  assert.deepEqual(protectedBy((state) => state.kept.add("a")), ["kept"]);
});

test("off protects every tab", () => {
  assert.deepEqual(protectedBy(null, { enabled: false }), ["off"]);
});

test("undeclared protects a tab of a plugin without surface.unload", () => {
  assert.deepEqual(protectedBy(null, { tab: "u-a" }), ["undeclared"]);
});

test("background protects a tab of a plugin with a background session", () => {
  assert.deepEqual(protectedBy(null, { tab: "g-a" }), ["background"]);
});

test("a media reply protects a tab and moves its deadline one delay later", () => {
  let asked = 0;
  assert.deepEqual(protectedBy(null, { regions: () => { asked++; return { regions: ["media"] }; } }), ["media"]);
  // The first deadline at 120 minutes and the next one at 240 minutes each asked the regions once.
  assert.equal(asked, 2);
});

test("capture and form replies protect a tab", () => {
  assert.deepEqual(protectedBy(null, { regions: () => ({ regions: ["capture", "form"] }) }), ["capture", "form"]);
});

test("an unload stores the session of the tab first, and a restore gives the regions of the tab the stored session", () => {
  const stored = [];
  const h = harness({ interaction: (tab) => { stored.push(tab); return {}; } });
  h.observe(new Set(["b"]), tabs("a", "b"));
  h.tick(120 * MINUTE);
  assert.equal(h.unloaded("a"), true);
  assert.deepEqual(stored, ["a"]);
  assert.deepEqual(h.restores, []);
  h.observe(new Set(["a"]), tabs("a", "b"));
  assert.deepEqual(h.restores, ["a"]);
  h.restored("a", true);
  assert.deepEqual(h.named("workbench.tab.restored"), [{ tab: "a", plugin: "fixture", history: true }]);
});

test("turning the setting on keeps the hidden time of each tab", () => {
  const h = harness({ enabled: false });
  h.observe(new Set(["x"]), tabs("a", "x"));
  h.tick(100 * MINUTE);
  h.s.enabled = true;
  h.settingsChanged();
  h.tick(20 * MINUTE - 1);
  assert.equal(h.unloaded("a"), false);
  h.tick(1);
  assert.equal(h.unloaded("a"), true);
});

test("a tab mounted without being shown takes its mount time as its hidden time", () => {
  const h = harness();
  h.observe(new Set(["x"]), tabs("x"));
  h.tick(30 * MINUTE);
  h.observe(new Set(["x"]), tabs("x", "a"));
  h.tick(120 * MINUTE - 1);
  assert.equal(h.unloaded("a"), false);
  h.tick(1);
  assert.equal(h.unloaded("a"), true);
});

test("one critical report unloads hidden tabs one at a time, least recently shown first, until a normal report", () => {
  // Each commit waits for its reply, which the test releases in turn.
  const h = harness();
  // a, b and c are shown in this order and then hidden; recent does not protect under pressure.
  for (const id of ["c", "a", "b", "d"]) {
    h.observe(new Set([id]), tabs("a", "b", "c", "d"));
    h.tick(MINUTE);
  }
  h.pressure({ level: "critical", seq: 1 });
  h.settle(["regions", "interaction"]);
  assert.equal(h.commits.length, 1);
  h.release("commit");
  h.settle(["regions", "interaction"]);
  assert.equal(h.commits.length, 2);
  h.release("commit");
  h.settle(["regions", "interaction"]);
  assert.equal(h.commits.length, 3);
  h.pressure({ level: "normal", seq: 2 });
  h.release("commit");
  h.settle();
  assert.deepEqual(h.named("workbench.tab.unloaded").map((fields) => [fields.tab, fields.trigger]),
    [["c", "pressure"], ["a", "pressure"], ["b", "pressure"]]);
  assert.equal(h.unloaded("d"), false);
  // A normal report stops the unloads of a later critical report after the unload in progress.
  h.observe(new Set(["a"]), tabs("a", "b", "c", "d"));
  h.observe(new Set(["b"]), tabs("a", "b", "c", "d"));
  h.pressure({ level: "critical", seq: 3 });
  h.settle(["regions", "interaction"]);
  assert.equal(h.commits.length, 4);
  h.pressure({ level: "normal", seq: 4 });
  h.release("commit");
  h.settle();
  assert.equal(h.commits.length, 4);
  assert.equal(h.named("workbench.tab.unloaded").length, 4);
});

test("a pressure report without a candidate is workbench.tab.unload.skipped", () => {
  const h = harness();
  h.s.keeps.set("a", ["keep:busy"]);
  h.observe(new Set(["x"]), tabs("a", "x"));
  h.pressure({ level: "warn", seq: 7 });
  h.settle();
  assert.deepEqual(h.named("workbench.tab.unload.skipped"), [{ trigger: "pressure", seq: 7, reasons: ["shown", "keep:busy"] }]);
  assert.equal(h.unloaded("a"), false);
});

for (const [name, interrupt, reasons] of [
  ["a show", (h) => h.observe(new Set(["a"]), tabs("a", "x")), ["shown"]],
  ["a show and a hide", (h) => {
    h.observe(new Set(["a"]), tabs("a", "x"));
    h.observe(new Set(["x"]), tabs("a", "x"));
  }, ["shown"]],
  ["a modified report", (h) => { h.s.keeps.set("a", ["keep:modified"]); h.protectionsChanged(); }, ["keep:modified"]],
]) {
  test(`${name} during a pending awaited step leaves the tab loaded`, () => {
    const h = harness();
    h.observe(new Set(["x"]), tabs("a", "x"));
    h.s.at += 120 * MINUTE;
    h.fire();
    // The regions step is answered; the interaction step waits until the case releases it.
    h.settle(["regions"]);
    interrupt(h);
    h.settle(["interaction"]);
    assert.equal(h.unloaded("a"), false);
    assert.deepEqual(h.commits, []);
    assert.deepEqual(h.named("workbench.tab.unload.skipped"), [{ trigger: "delay", seq: 0, reasons }]);
  });
}

test("a commit after an unload neither declares the tab nor releases it as a closed tab", () => {
  const h = harness();
  h.observe(new Set(["x"]), tabs("a", "x"));
  h.tick(120 * MINUTE);
  assert.equal(h.unloaded("a"), true);
  const placed = h.place([{ id: "x" }, { id: "a" }]);
  // The tab stays in the layout: it is among the retained surfaces, so the commit does not release it as a closed tab
  // (which forgets its reports), and it is not declared, so the host keeps no surface for it.
  assert.deepEqual(placed.surfaces.map((surface) => surface.id), ["x"]);
  assert.deepEqual([...placed.retain], ["x", "a"]);
  assert.deepEqual(placed.unload, ["a"]);
});

test("a restart with the setting on starts hidden declaring tabs unloaded with their cached label", () => {
  const declaration = ({ plugin }) => (plugin === "undeclared" ? "undeclared" : "unload");
  const on = harness({ declaration });
  on.observe(new Set(["x"]), tabs("x", "a", "u-b"));
  on.classify();
  assert.equal(on.unloaded("a"), true);
  assert.equal(on.unloaded("u-b"), false);
  assert.equal(on.unloaded("x"), false);
  assert.deepEqual(on.labels, ["a"]);
  assert.deepEqual(on.named("workbench.tab.unloaded"), []);
  const off = harness({ declaration, enabled: false });
  off.observe(new Set(["x"]), tabs("x", "a"));
  off.classify();
  assert.equal(off.unloaded("a"), false);
});

test("core.tab.unload unloads a hidden tab that recent and the regions protect", () => {
  const h = harness({ regions: () => ({ regions: ["media", "capture", "form"] }) });
  h.observe(new Set(["a"]), tabs("a", "x"));
  h.observe(new Set(["x"]), tabs("a", "x"));
  assert.deepEqual(h.reasons("a"), ["recent"]);
  h.changes = 0;
  const request = h.unload("a");
  h.settle();
  assert.equal(h.settled.get(request), null);
  assert.equal(h.unloaded("a"), true);
  assert.deepEqual(h.commits, [["a"]]);
  assert.deepEqual(h.named("workbench.tab.unloaded"), [{ tab: "a", plugin: "fixture", trigger: "command" }]);
  assert.ok(h.changes > 0, "the unload is not announced");
  // An unloaded tab is unloaded again without another commit.
  const again = h.unload("a");
  assert.equal(h.settled.get(again), null);
  assert.deepEqual(h.commits, [["a"]]);
});

test("core.tab.unload refuses a tab that a standing reason protects", () => {
  const h = harness();
  h.observe(new Set(["x"]), tabs("x", "k", "u-a", "g-a"));
  h.s.kept.add("k");
  h.s.keeps.set("k", ["keep:modified"]);
  assert.throws(() => h.unload("x"), { message: "tab x is protected: shown" });
  assert.throws(() => h.unload("k"), { message: "tab k is protected: keep:modified, kept" });
  assert.throws(() => h.unload("u-a"), { message: "tab u-a is protected: undeclared" });
  assert.throws(() => h.unload("g-a"), { message: "tab g-a is protected: background" });
  assert.throws(() => h.unload("missing"), { message: "unknown tab missing" });
  assert.deepEqual(h.commits, []);
});

test("core.tab.unload fails with the reasons that ended the attempt", () => {
  const h = harness();
  h.observe(new Set(["x"]), tabs("a", "x"));
  const request = h.unload("a");
  // The tab is shown while its regions step waits.
  h.observe(new Set(["a"]), tabs("a", "x"));
  h.settle();
  assert.equal(h.settled.get(request).message, "tab a is protected: shown");
  assert.equal(h.unloaded("a"), false);
});

test("core.tab.keep sets and clears the mark once per change", () => {
  const h = harness();
  h.observe(new Set(["x"]), tabs("x", "a", "u-a", "g-a"));
  h.keep("a", true);
  h.keep("a", true);
  assert.deepEqual(h.reasons("a"), ["kept"]);
  h.keep("a", false);
  assert.equal(h.s.kept.has("a"), false);
  assert.deepEqual(h.named("workbench.tab.keep.changed"), [{ tab: "a", keep: true }, { tab: "a", keep: false }]);
  assert.throws(() => h.keep("u-a", true), { message: "tab u-a can never be unloaded: undeclared" });
  assert.throws(() => h.keep("g-a", false), { message: "tab g-a can never be unloaded: background" });
  assert.throws(() => h.keep("missing", true), { message: "unknown tab missing" });
});

test("the status lists each tab with its state, reasons and times", () => {
  const h = harness();
  h.observe(new Set(["x"]), tabs("x", "a"));
  const hidden = h.s.at;
  h.pressure({ level: "normal", seq: 3 });
  assert.deepEqual(h.status(), {
    pressure: { level: "normal", seq: 3 },
    tabs: [
      { tab: "x", plugin: "fixture", kind: "tab", state: "loaded", reasons: ["shown"], hiddenAt: null, unloadAt: null, checkedAt: null },
      { tab: "a", plugin: "fixture", kind: "tab", state: "loaded", reasons: [], hiddenAt: hidden, unloadAt: hidden + 120 * MINUTE,
        checkedAt: null },
    ],
  });
  h.tick(120 * MINUTE);
  assert.deepEqual(h.status().tabs[1], { tab: "a", plugin: "fixture", kind: "tab", state: "unloaded", reasons: [], hiddenAt: hidden,
    unloadAt: null, checkedAt: hidden + 120 * MINUTE });
});

test("a rejected interactionState read ends the attempt with a reported failure and keeps the tab loaded", () => {
  const h = harness({ interaction: () => ({ error: new Error("document region page is gone") }) });
  h.observe(new Set(["b"]), tabs("a", "b"));
  h.tick(120 * MINUTE);
  assert.equal(h.unloaded("a"), false);
  assert.deepEqual(h.commits, []);
  assert.deepEqual(h.named("workbench.tab.unload.failed"),
    [{ tab: "a", plugin: "fixture", trigger: "delay", reason: "document region page is gone" }]);
  assert.deepEqual(h.failures, ["memory saver: tab a: unload failed: document region page is gone"]);
  // A read that keeps failing runs once per delay, not again at the deadline that passed.
  h.tick(0);
  assert.equal(h.failures.length, 1);
  h.tick(120 * MINUTE);
  assert.equal(h.failures.length, 2);
  assert.deepEqual(h.states, []);
});

for (const [step, options] of Object.entries({
  "the regions read": { regions: () => ({ error: new Error("step refused") }) },
  "the interactionState read": { interaction: () => ({ error: new Error("step refused") }) },
  "the commit": { commit: () => ({ error: new Error("step refused") }) },
})) {
  test(`a failed ${step} at the deadline runs again one delay later, not at the deadline that passed`, () => {
    const h = harness(options);
    h.observe(new Set(["b"]), tabs("a", "b"));
    h.tick(120 * MINUTE);
    const attempts = () => h.named("workbench.tab.unload.failed").length;
    assert.equal(attempts(), 1);
    // A tick of 0 runs a deadline that the end of the attempt set for the same time.
    for (let turn = 0; turn < 5; turn++) h.tick(0);
    assert.equal(attempts(), 1);
    assert.equal(h.status().tabs.find(({ tab }) => tab === "a").unloadAt, START + 240 * MINUTE);
    h.tick(120 * MINUTE - 1);
    assert.equal(attempts(), 1);
    h.tick(1);
    assert.equal(attempts(), 2);
    assert.equal(h.unloaded("a"), false);
    assert.ok(h.failures.length >= 2);
  });
}

test("a shown unloaded tab is restoring until its surface mounts, and a failed restore is reported", () => {
  const h = harness();
  h.observe(new Set(["b"]), tabs("a", "b"));
  h.tick(120 * MINUTE);
  h.observe(new Set(["a"]), tabs("a", "b"));
  assert.deepEqual(h.states, [["a", "unloaded"], ["a", "restoring"]]);
  assert.deepEqual(h.named("workbench.tab.restored"), []);
  h.restoreFailed("a", "stored format 2 is not the declared format 1");
  assert.equal(h.unloaded("a"), false);
  assert.deepEqual(h.states.at(-1), ["a", "loaded"]);
  assert.deepEqual(h.named("workbench.tab.restore.failed"),
    [{ tab: "a", plugin: "fixture", reason: "stored format 2 is not the declared format 1" }]);
  assert.deepEqual(h.failures, ["memory saver: tab a: restore failed: stored format 2 is not the declared format 1"]);
});

test("a failed commit after the tab is marked returns it to loaded with a reported failure", () => {
  let fail = true;
  const h = harness({
    commit: () => {
      if (!fail) return {};
      fail = false;
      return { error: new Error("host.place refused the layout") };
    },
  });
  h.observe(new Set(["b"]), tabs("a", "b"));
  h.tick(120 * MINUTE);
  assert.equal(h.unloaded("a"), false);
  assert.equal(h.state("a"), "loaded");
  // The commit after the failure declares the surface of the tab again.
  assert.deepEqual(h.commits, [["a"], []]);
  assert.deepEqual(h.named("workbench.tab.unloaded"), []);
  assert.deepEqual(h.named("workbench.tab.unload.failed"),
    [{ tab: "a", plugin: "fixture", trigger: "delay", reason: "host.place refused the layout" }]);
  assert.deepEqual(h.failures, ["memory saver: tab a: unload failed: host.place refused the layout"]);
  assert.deepEqual(h.states, [["a", "unloaded"], ["a", "loaded"]]);
});

test("a session history refused at the first show after a restart is reported for a tab that no commit gave the memory saver", () => {
  const h = harness();
  h.historyRefused("a", "fixture", "document region page: the web view refused the interactionState");
  assert.equal(h.state("a"), null);
  assert.deepEqual(h.named("workbench.tab.restore.failed"),
    [{ tab: "a", plugin: "fixture", reason: "document region page: the web view refused the interactionState" }]);
  assert.deepEqual(h.failures, ["memory saver: tab a: restore failed: document region page: the web view refused the interactionState"]);
});

test("a refused session history keeps the restore open, and the later mount still emits workbench.tab.restored", () => {
  const h = harness();
  h.observe(new Set(["b"]), tabs("a", "b"));
  h.tick(120 * MINUTE);
  h.observe(new Set(["a"]), tabs("a", "b"));
  // The region refuses its history during the mount and attaches again without it.
  h.historyRefused("a", "fixture", "document region page: interactionState is not a session history");
  assert.equal(h.state("a"), "restoring");
  assert.deepEqual(h.named("workbench.tab.restore.failed"),
    [{ tab: "a", plugin: "fixture", reason: "document region page: interactionState is not a session history" }]);
  assert.deepEqual(h.failures,
    ["memory saver: tab a: restore failed: document region page: interactionState is not a session history"]);
  h.restored("a", false);
  assert.equal(h.state("a"), "loaded");
  assert.deepEqual(h.named("workbench.tab.restored"), [{ tab: "a", plugin: "fixture", history: false }]);
  // A refusal after the mount ended reports the failure and leaves the tab loaded.
  h.historyRefused("a", "fixture", "document region page: refused");
  assert.equal(h.state("a"), "loaded");
  assert.equal(h.named("workbench.tab.restore.failed").length, 2);
});

test("a section surface is observed with the tabs and listed with kind section", () => {
  const h = harness();
  h.observe(new Set(["a"]), [{ id: "a", plugin: "p", kind: "tab" }, { id: "spc-aaaaaa/left/probe.tree", plugin: "probe", kind: "section" }]);
  assert.deepEqual(h.status().tabs.map(({ tab, kind, state }) => ({ tab, kind, state })), [
    { tab: "a", kind: "tab", state: "loaded" },
    { tab: "spc-aaaaaa/left/probe.tree", kind: "section", state: "loaded" },
  ]);
});

test("the tab commands refuse a section surface id, so only the memory saver unloads a section", () => {
  const h = harness();
  h.observe(new Set(), [{ id: "a", plugin: "p", kind: "tab" }, { id: "spc-aaaaaa/left/probe.tree", plugin: "probe", kind: "section" }]);
  assert.equal(h.core.tab("a"), "a");
  assert.throws(() => h.core.tab("spc-aaaaaa/left/probe.tree"), /^Error: spc-aaaaaa\/left\/probe.tree is a section surface, not a tab$/);
  assert.throws(() => h.core.tab("missing"), /unknown tab "missing"/);
});

test("a drawn placement starts unloaded every surface that it first holds hidden", async () => {
  const h = harness({ start: false });
  const saver = { classify: () => h.classify(), place: (surfaces) => h.place(surfaces) };
  const place = (record, candidates, shown) => memoryPlacement(record, candidates, {
    ready: Promise.resolve(), saver, start: (entries) => entries,
    observe: (_record, all) => h.observe(new Set(shown), all.map(({ id, plugin, kind }) => ({ id, plugin, kind, unload: true }))),
  });
  const tree = { id: "spc-aaaaaa/left/probe.tree", plugin: "fixture", kind: "section" };
  const marks = { id: "spc-aaaaaa/left/probe.marks", plugin: "fixture", kind: "section" };
  const tab = { id: "a", plugin: "fixture", kind: "tab" };
  // The library draws no surface.
  assert.deepEqual((await place({ drawn: true, surfaces: [] }, [], [])).surfaces, []);
  // A preparation before the draw of the plane has no complete seats, so it classifies nothing.
  await place({ drawn: false, surfaces: [] }, [tab, marks], [tab.id]);
  assert.equal(h.state(marks.id), "loaded");
  // The first drawn record of the project classifies its hidden section, so the placement never holds it.
  const { surfaces } = await place({ drawn: true, surfaces: [] }, [tab, tree, marks], [tab.id, tree.id]);
  assert.deepEqual(surfaces.map(({ id }) => id), [tab.id, tree.id]);
  assert.equal(h.state(marks.id), "unloaded");
  assert.equal(h.state(tree.id), "loaded");
  // A section that a set linked later shows hidden has never been seen either, so it starts the same way.
  const later = { id: "spc-aaaaaa/left/probe.later", plugin: "fixture", kind: "section" };
  const next = await place({ drawn: true, surfaces: [] }, [tab, tree, marks, later], [tab.id, tree.id]);
  assert.deepEqual(next.surfaces.map(({ id }) => id), [tab.id, tree.id]);
  assert.equal(h.state(later.id), "unloaded");
  // A surface that lost its show stays until the delay: it is no longer first seen.
  const hidden = await place({ drawn: true, surfaces: [] }, [tab, tree, marks, later], [tab.id]);
  assert.deepEqual(hidden.surfaces.map(({ id }) => id), [tab.id, tree.id]);
  assert.equal(h.state(tree.id), "loaded");
});

test("a surface first seen while the setting is off waits for the delay after the setting turns on", () => {
  const h = harness({ start: false, enabled: false });
  h.observe(new Set(["x"]), tabs("x", "a"));
  h.classify();
  assert.equal(h.state("a"), "loaded");
  h.s.enabled = true;
  h.classify();
  assert.equal(h.state("a"), "loaded");
  h.observe(new Set(["x"]), tabs("x", "a", "b"));
  h.classify();
  assert.equal(h.state("a"), "loaded");
  assert.equal(h.state("b"), "unloaded");
});
