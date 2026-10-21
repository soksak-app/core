import assert from "node:assert/strict";
import test from "node:test";

import * as counts from "../measure-object-counts.mjs";
import { measure } from "../measure-object-counts.mjs";

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
  };
}

test("the operations name no plugin: each plugin of --plugin has a tab operation and the split uses the first", () => {
  assert.deepEqual(counts.operationsFor?.(["probe-a", "probe-b"]), ["tab.probe-a", "tab.probe-b", "card.split", "plugins.apply", "project.window"]);
  assert.deepEqual(counts.parseOptions(["--sok", "s", "--config-dir", "d", "--plugin", "probe-a", "--plugin", "probe-b"]).plugins, ["probe-a", "probe-b"]);
});

test("the measurement requires at least one --plugin", () => {
  assert.throws(() => counts.parseOptions(["--sok", "s", "--config-dir", "d"]), /--plugin/);
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
  assert.deepEqual(entries[1].footprint, { page: { pid: 42, bytes: 42_000 }, documents: [{ surface: "probe", document: "doc", pid: 43, bytes: 43_000 }] });
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
  assert.deepEqual(calls.slice(4, 7), ["status", "footprint 42", "footprint 43"]);
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
