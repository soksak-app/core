import assert from "node:assert/strict";
import test from "node:test";

import * as counts from "../measure-object-counts.mjs";
import { countsOf, measure } from "../measure-object-counts.mjs";

const OPERATIONS = counts.operationsFor(["probe"]);

/** The diagnostics.objects reply with every host, page and document count set to n. */
function snapshot(n) {
  return {
    host: { surfaces: n, regions: n, documents: n, sidecarSessions: n, pendingReplies: n, eventSubscribers: n },
    page: { elements: n, documents: n },
    documents: [{ surface: "probe", document: "doc", elements: n, documents: n }],
  };
}

/** Effects of a window with one page process and one document process; each effect records its call in calls. */
function effects(calls, objectsOf) {
  let operations = 0;
  return {
    operations: OPERATIONS,
    objects: async () => { calls.push("objects"); return objectsOf(operations); },
    operate: async (name) => { operations += 1; calls.push(`operate ${name}`); },
    settle: async () => { calls.push("settle"); },
    status: async () => { calls.push("status"); return { pageProcess: 42, documents: [{ surface: "probe", document: "doc", process: 43 }] }; },
    footprint: (pid) => { calls.push(`footprint ${pid}`); return pid * 1000; },
    host: 41,
  };
}

test("the operations name no plugin: each plugin of --plugin has a tab operation and the split uses the first", () => {
  assert.deepEqual(counts.operationsFor?.(["probe-a", "probe-b"]), ["tab.probe-a", "tab.probe-b", "card.split", "divider.drag", "card.menu",
    "settings.window", "plugins.apply", "project.window"]);
  assert.deepEqual(counts.parseOptions(["--sok", "s", "--config-dir", "d", "--trace", "0", "--plugin", "probe-a", "--plugin", "probe-b"]).plugins,
    ["probe-a", "probe-b"]);
});

test("the measurement requires at least one --plugin and the trace state", () => {
  assert.throws(() => counts.parseOptions(["--sok", "s", "--config-dir", "d", "--trace", "0"]), /--plugin/);
  assert.equal(counts.parseOptions(["--sok", "s", "--config-dir", "d", "--trace", "1", "--plugin", "probe"]).trace, 1);
  assert.throws(() => counts.parseOptions(["--sok", "s", "--config-dir", "d", "--plugin", "probe"]), /TRACE must be 0 or 1, not set/);
  assert.throws(() => counts.parseOptions(["--sok", "s", "--config-dir", "d", "--trace", "on", "--plugin", "probe"]), /TRACE must be 0 or 1, not "on"/);
  assert.equal(counts.parseOptions(["--sok", "s", "--config-dir", "d", "--trace", "0", "--plugin", "probe"]).b3Out, null);
  assert.equal(counts.parseOptions(["--sok", "s", "--config-dir", "d", "--trace", "0", "--plugin", "probe", "--repetitions", "30", "--b3-out", "/o/s3.json"]).b3Out,
    "/o/s3.json");
  assert.throws(() => counts.parseOptions(["--sok", "s", "--config-dir", "d", "--trace", "0", "--plugin", "probe", "--b3-out", "/o/s3.json"]),
    /--b3-out needs at least 30 repetitions, not 20/);
});

test("constant counts are not reported as growing", async () => {
  const entries = [];
  const calls = [];
  const summary = [];
  const result = await measure({
    ...effects(calls, () => snapshot(5)),
    repetitions: 4,
    log: (entry) => (entry.count ? summary.push(entry) : entries.push(entry)),
  });
  assert.equal(entries.length, 5, "baseline plus one entry per repetition");
  assert.deepEqual(entries.map((entry) => entry.repetition), [0, 1, 2, 3, 4]);
  assert.equal(summary.length, Object.keys(result).length);
  assert.ok(summary.every((entry) => entry.grows === false));
  assert.deepEqual(entries[1].footprint, { host: { pid: 41, bytes: 41_000 }, page: { pid: 42, bytes: 42_000 },
    documents: [{ surface: "probe", document: "doc", pid: 43, bytes: 43_000 }] });
  assert.equal(entries[1].runtime, null, "a reply without runtime figures, as the Tauri host gives, logs none");
});

test("a count that rises in every repetition after the second is reported as growing", async () => {
  const summary = [];
  const calls = [];
  await measure({
    ...effects(calls, (operations) => snapshot(operations)),
    repetitions: 4,
    log: (entry) => { if (entry.count) summary.push(entry); },
  });
  const byName = Object.fromEntries(summary.map((entry) => [entry.count, entry]));
  assert.equal(byName["host.surfaces"].grows, true);
  assert.equal(byName["page.elements"].grows, true);
  assert.equal(byName["documents.elements"].grows, true);
  assert.deepEqual(byName["host.surfaces"].values, [OPERATIONS.length, 2 * OPERATIONS.length, 3 * OPERATIONS.length, 4 * OPERATIONS.length]);
});

test("a count that rises only in the first repetitions is not reported as growing", async () => {
  const summary = [];
  const calls = [];
  // Rises from the baseline to the first repetition, then stays at the same value.
  await measure({
    ...effects(calls, (operations) => snapshot(operations > 0 ? 9 : 1)),
    repetitions: 4,
    log: (entry) => { if (entry.count) summary.push(entry); },
  });
  assert.ok(summary.every((entry) => entry.grows === false));
});

test("each operation is followed by a settle, and every reading follows a settle", async () => {
  const calls = [];
  await measure({
    ...effects(calls, () => snapshot(1)),
    repetitions: 1,
    log: () => {},
  });
  // Baseline: two equal readings, each after a settle.
  assert.deepEqual(calls.slice(0, 4), ["settle", "objects", "settle", "objects"]);
  assert.deepEqual(calls.slice(4, 8), ["status", "footprint 41", "footprint 42", "footprint 43"]);
  // Repetition: each operation is settled before the reading.
  const repetition = calls.slice(calls.findIndex((call) => call.startsWith("operate ")));
  const expected = OPERATIONS.flatMap((name) => [`operate ${name}`, "settle"]);
  assert.deepEqual(repetition.slice(0, expected.length), expected);
  assert.equal(repetition[expected.length], "objects");
});

test("the baseline is the first reading that equals the reading before it", async () => {
  const values = [1, 2, 2, 7];
  const reads = [];
  const summary = [];
  const entries = [];
  const calls = [];
  await measure({
    ...effects(calls, () => snapshot(7)),
    objects: async () => { const value = values.shift(); reads.push(value); return snapshot(value ?? 7); },
    repetitions: 0,
    log: (entry) => (entry.count ? summary.push(entry) : entries.push(entry)),
  });
  assert.deepEqual(reads, [1, 2, 2], "the readings stop at the first equal pair");
  assert.equal(entries[0].repetition, 0);
  assert.equal(entries[0].counts["host.surfaces"], 2);
});

test("a baseline whose first two readings differ and whose next two are equal takes the equal value after three or more settles", async () => {
  const values = [1, 2, 5, 5];
  const calls = [];
  const entries = [];
  await measure({
    ...effects(calls, () => snapshot(5)),
    objects: async () => { calls.push("objects"); return snapshot(values.length > 0 ? values.shift() : 5); },
    repetitions: 1,
    log: (entry) => { if (!entry.count) entries.push(entry); },
  });
  assert.equal(entries[0].repetition, 0);
  assert.equal(entries[0].counts["host.surfaces"], 5);
  const firstOperation = calls.findIndex((call) => call.startsWith("operate "));
  const beforeOperation = calls.slice(0, firstOperation);
  assert.equal(beforeOperation.filter((call) => call === "settle").length, 4, "one settle per reading, four readings");
  assert.equal(beforeOperation.filter((call) => call === "objects").length, 4);
  assert.ok(beforeOperation.filter((call) => call === "settle").length >= 3);
});

test("a baseline that never settles throws after 10 readings, naming the last two", async () => {
  let n = 0;
  const calls = [];
  await assert.rejects(measure({
    ...effects(calls, () => snapshot(0)),
    objects: async () => { calls.push("objects"); return snapshot(n++); },
    repetitions: 0,
    log: () => {},
  }), (error) => {
    assert.match(error.message, /object counts did not settle within 10 readings/);
    assert.match(error.message, /"host.surfaces":8,/);
    assert.match(error.message, /"host.surfaces":9,/);
    assert.doesNotMatch(error.message, /"host.surfaces":7,/);
    return true;
  });
  assert.equal(calls.filter((call) => call === "objects").length, 10);
});

/** The Go runtime figures of diagnostics.objects (docs/spec/endpoint.md), each set to n. */
function runtime(n) {
  return { heapObjectsBytes: n, heapUnusedBytes: n, heapFreeBytes: n, heapReleasedBytes: n, stacksBytes: n, metadataOtherBytes: n,
    heapGoalBytes: n, goroutines: n };
}

/** A window of the mygo host: host.window reports pageProcess null, and diagnostics.objects reports page null and the runtime figures. */
function mygo(calls) {
  let readings = 0;
  return {
    ...effects(calls, () => snapshot(3)),
    // The counts stay the same and the goroutines are the number of the reading.
    objects: async () => {
      calls.push("objects");
      readings += 1;
      return { ...snapshot(3), page: null, sessions: [], runtime: { ...runtime(3), goroutines: readings } };
    },
    status: async () => { calls.push("status"); return { pageProcess: null, documents: [{ surface: "probe", document: "", process: 43 }] }; },
  };
}

test("a window of the mygo host reads the host footprint and the runtime figures in every repetition and no page process", async () => {
  const calls = [];
  const entries = [];
  await measure({
    ...mygo(calls),
    repetitions: 2,
    log: (entry) => { if (entry.count === undefined) entries.push(entry); },
  });
  assert.deepEqual(entries.map((entry) => entry.repetition), [0, 1, 2]);
  for (const entry of entries) {
    assert.deepEqual(entry.footprint.host, { pid: 41, bytes: 41_000 });
    assert.equal(entry.footprint.page, null);
    assert.deepEqual(entry.footprint.documents, [{ surface: "probe", document: "", pid: 43, bytes: 43_000 }]);
    assert.ok(!("page.elements" in entry.counts), "a window without a main page has no page counts");
  }
  // The baseline is the second of two equal readings.
  assert.deepEqual(entries.map((entry) => entry.runtime.goroutines), [2, 3, 4]);
  assert.ok(!calls.includes("footprint null"), "the measurement read the footprint of a page process that does not exist");
});

test("a reply whose page does not match the page process of host.window is an error that names both", async () => {
  const calls = [];
  await assert.rejects(measure({
    ...mygo(calls),
    objects: async () => ({ ...snapshot(1), runtime: runtime(1) }),
    repetitions: 0, log: () => {},
  }), /diagnostics\.objects reports the page \{"elements":1,"documents":1\} while host\.window reports pageProcess null/);
  await assert.rejects(measure({
    ...effects(calls, () => ({ ...snapshot(1), page: null })),
    repetitions: 0, log: () => {},
  }), /diagnostics\.objects reports the page null while host\.window reports pageProcess 42/);
});

test("runtime figures that are not non-negative integers are an error that names the figure", async () => {
  const calls = [];
  await assert.rejects(measure({
    ...effects(calls, () => ({ ...snapshot(1), runtime: { ...runtime(1), goroutines: -1 } })),
    repetitions: 0, log: () => {},
  }), /runtime figure goroutines is not a non-negative integer \(-1\)/);
  await assert.rejects(measure({
    ...effects(calls, () => { const { goroutines, ...rest } = runtime(1); return { ...snapshot(1), runtime: rest }; }),
    repetitions: 0, log: () => {},
  }), /runtime figure goroutines is not a non-negative integer \(undefined\)/);
});

/**
 * A fake application for the operation steps: run and request record each command, the statuses follow the commands, and until
 * records each wait and fails when the status does not satisfy its condition.
 */
function application() {
  const calls = [];
  const state = { picker: false, settings: false, cards: [{ id: "main", fixed: false, c0: 1 }] };
  const statuses = {
    "core.grid": () => ({ cards: state.cards }),
    "core.picker": () => ({ open: state.picker }),
    "core.settings-modal": () => ({ open: state.settings }),
  };
  const run = async (args) => {
    calls.push(args.join(" "));
    const [name] = args;
    if (name === "status") return statuses[args[1]]();
    if (name === "core.card.split") { state.cards.push({ id: "split", fixed: false, c0: 2 }); return { card: "split" }; }
    if (name === "core.card.close") { state.cards = state.cards.filter((card) => card.id !== "split"); return null; }
    if (name === "core.card.menu") { state.picker = true; return null; }
    if (name === "core.picker.close") { state.picker = false; return null; }
    if (name === "core.settings.open") { state.settings = true; return null; }
    if (name === "core.settings.close") { state.settings = false; return null; }
    throw new Error(`no command ${name}`);
  };
  const request = async (method, params) => { calls.push(`${method} ${JSON.stringify(params)}`); return { steps: 12 }; };
  const until = async (name, predicate) => {
    const value = statuses[name]();
    calls.push(`until ${name} ${JSON.stringify(value)}`);
    if (!predicate(value)) throw new Error(`status ${name} did not satisfy the condition: ${JSON.stringify(value)}`);
    return value;
  };
  const steps = (overrides = {}) => counts.operationSteps({
    window: "w1", plugins: ["probe"], run, request, until, waitFor: async () => { throw new Error("no wait on windows"); }, projectRoot: "/p",
    ...overrides,
  });
  return { calls, run, steps };
}

test("the divider drag splits a card, drags the boundary of the split through diagnostics.drag and closes the split", async () => {
  const { calls, steps } = application();
  await steps()["divider.drag"]();
  assert.deepEqual(calls, [
    "status core.grid --window w1",
    "core.card.split --window w1 --card main --side right --plugin probe",
    "status core.grid --window w1",
    `diagnostics.drag ${JSON.stringify({ window: "w1", axis: "x", line: 2, dx: 40, dy: 0, ms: 200, times: 1 })}`,
    "core.card.close --window w1 --card split",
  ]);
});

test("the menu and the settings window open and close through their declared commands and wait for their statuses", async () => {
  const { calls, steps } = application();
  await steps()["card.menu"]();
  await steps()["settings.window"]();
  assert.deepEqual(calls, [
    "status core.grid --window w1",
    "core.card.menu --window w1 --card main --menu add",
    'until core.picker {"open":true}',
    "core.picker.close --window w1",
    'until core.picker {"open":false}',
    "core.settings.open --window w1",
    'until core.settings-modal {"open":true}',
    "core.settings.close --window w1",
    'until core.settings-modal {"open":false}',
  ]);
});

test("a divider drag whose split card is missing from core.grid fails with the cards it found", async () => {
  const { run, steps } = application();
  const step = steps({ run: async (args) => (args[0] === "core.card.split" ? { card: "other" } : run(args)) })["divider.drag"];
  await assert.rejects(step(), /core\.grid reports no card other after core\.card\.split: \["main"\]/);
});

test("every count of every object member of the reply outside runtime, documents and sessions is a count of the measurement", async () => {
  // The mygo host adds the counts of its workbench, its native views and its framework callbacks; their member names are the host's.
  const counted = countsOf({ ...snapshot(2), page: null, sessions: [], runtime: runtime(9), added: { first: 4, second: 0 },
    host: { ...snapshot(2).host, more: 6 } });
  assert.equal(counted["added.first"], 4);
  assert.equal(counted["added.second"], 0);
  assert.equal(counted["host.more"], 6);
  assert.equal(countsOf({ ...snapshot(2), page: { elements: 2, documents: 1, more: 5 } })["page.more"], 5);
  assert.throws(() => countsOf({ ...snapshot(2), page: { elements: 2, documents: 1, more: null } }),
    /object count page\.more is not a non-negative integer \(null\)/);
  assert.ok(!Object.keys(counted).some((name) => name.startsWith("runtime.") || name.startsWith("sessions")), "runtime figures are not counts");
  assert.throws(() => countsOf({ ...snapshot(2), added: { first: -1 } }), /object count added\.first is not a non-negative integer \(-1\)/);
  assert.throws(() => countsOf({ ...snapshot(2), added: 3 }), /diagnostics\.objects member added is not an object of counts \(3\)/);
  assert.throws(() => countsOf({ ...snapshot(2), host: { ...snapshot(2).host, more: "6" } }), /object count host\.more is not a non-negative integer \("6"\)/);
});

/** The repetition entries 0 to 30 of a run: counts and figures as countOf and figureOf give them for each repetition. */
function run30(countOf, figureOf) {
  return Array.from({ length: 31 }, (_, repetition) => ({
    repetition,
    counts: { "host.surfaces": countOf(repetition, "host.surfaces"), "page.elements": countOf(repetition, "page.elements") },
    runtime: { ...runtime(100), heapObjectsBytes: figureOf(repetition, "heapObjectsBytes"), heapReleasedBytes: 50 + repetition },
    footprint: { host: { pid: 41, bytes: figureOf(repetition, "host") }, page: null, documents: [] },
  }));
}

test("the B3 measurements count the counts that change after the first repetition and the figures that grow from repetitions 11-20 to 21-30", () => {
  const steady = run30(() => 5, () => 1000);
  assert.deepEqual(counts.b3Measurements(steady), { changedCounts: 0, growingFigures: 0 });
  // A count that differs from its first repetition in one later repetition, and a baseline that differs, which is not judged.
  const changed = run30((repetition, name) => (name === "page.elements" && repetition === 17 ? 6 : repetition === 0 ? 1 : 5), () => 1000);
  assert.equal(counts.b3Measurements(changed).changedCounts, 1);
  // The host footprint and one runtime figure rise in every repetition; heapReleasedBytes rises too but is not judged.
  const growing = run30(() => 5, (repetition, name) => (name === "host" ? 1000 + repetition : 100 + repetition));
  assert.equal(counts.b3Measurements(growing).growingFigures, 2);
  // A figure whose lowest value over 21-30 equals its highest over 11-20 does not grow.
  const touching = run30(() => 5, (repetition) => (repetition <= 20 ? (repetition === 15 ? 1010 : 1000) : 1010));
  assert.equal(counts.b3Measurements(touching).growingFigures, 0);
  // A host without runtime figures judges the host footprint alone.
  const tauri = run30(() => 5, (repetition) => 1000 + repetition).map((entry) => ({ ...entry, runtime: null }));
  assert.equal(counts.b3Measurements(tauri).growingFigures, 1);
});

test("the B3 measurements need repetitions 0 to 30 and a count of the first repetition in every later one", () => {
  assert.throws(() => counts.b3Measurements(run30(() => 5, () => 1).slice(0, 30)),
    /the B3 measurements of object-counts need the repetitions 1 to 30, not 1 to 29/);
  const missing = run30(() => 5, () => 1);
  delete missing[12].counts["page.elements"];
  assert.equal(counts.b3Measurements(missing).changedCounts, 1, "a count that a later repetition lacks has changed");
});

test("B3_MEASUREMENTS declares the keys of the B3 output of object-counts, which b3Measurements gives", () => {
  assert.deepEqual(counts.B3_MEASUREMENTS, ["changedCounts", "growingFigures"]);
  assert.ok(Object.isFrozen(counts.B3_MEASUREMENTS));
  assert.deepEqual(Object.keys(counts.b3Measurements(run30(() => 5, () => 1))), counts.B3_MEASUREMENTS);
});

test("the B3 output of object-counts states the performance switch that TRACE set, the policy and the window it measured", () => {
  const status = { refreshRate: 120, scale: 2, content: { width: 1200, height: 760 }, pageProcess: null };
  const policy = { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "debug" };
  const on = counts.b3Output({ entries: run30(() => 5, () => 1), window: "w1", status, trace: 1, policy });
  assert.deepEqual(on, {
    measurements: { changedCounts: 0, growingFigures: 0 },
    conditions: { refreshRate: 120, backingScale: 2, traceState: true, logPolicy: policy, window: { width: 1200, height: 760 } },
  });
  assert.equal(counts.b3Output({ entries: run30(() => 5, () => 1), window: "w1", status, trace: 0, policy }).conditions.traceState, false);
  assert.throws(() => counts.b3Output({ entries: run30(() => 5, () => 1), window: "w1", status: { ...status, refreshRate: null }, trace: 0, policy }),
    /window w1 reports the refresh rate null, so it is on no screen/);
});
