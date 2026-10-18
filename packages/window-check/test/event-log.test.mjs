// Checks that a window check reads the error events that were written during the check from the event log of the
// application (docs/spec/logging.md#files).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { currentEventOffsets, eventLine, eventOffsetFile, sessionEventStart, readEvents, traceRows, readEventErrors, readEventLines, readEventOffsets, untilEventLine, untilEventLines, writeEventOffsets } from "../event-log.mjs";

function configDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-event-log-"));
  // The offsets of a configuration folder are the file beside it (eventOffsetFile), which a test may write.
  t.after(() => { rmSync(dir, { recursive: true }); rmSync(eventOffsetFile(dir), { force: true }); });
  mkdirSync(join(dir, "logs"));
  return dir;
}

/** The declarations of the records that the waits of these tests read, in the form of docs/spec/events.json. */
const CATALOG = { events: {
  "sidecar.vt.frame": { layer: "sidecar", class: "frame", level: "debug" },
  "host.record.<level>": { layer: "host", class: "lifecycle", level: ["error", "info"] },
  "page.record.<level>": { layer: "page", class: "lifecycle", level: ["error", "info"] },
} };
/** The declaration of a wait on the records of the host and the page. */
const RECORDS = { catalog: CATALOG, records: ["host.record.info", "page.record.info"] };
/** The policy that stores every level of every class (docs/spec/logging.md#policy-file). */
const EVERY = JSON.stringify({ schema: 1, classes: { lifecycle: "trace", input: "trace", call: "trace", io: "trace", frame: "trace" } });

const line = (seq, level, event, fields = {}, layer = "host") =>
  `${JSON.stringify({ ts_us: 1791000000000000 + seq, seq, level, layer, event, fields })}\n`;

test("readEventErrors returns the events of level error and ignores the other levels", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"),
    line(1, "info", "log.open", { schema: 2 }) + line(2, "warn", "host.test.warned") +
    line(3, "error", "host.test.failed", { where: "sidecar", text: "closed" }) + line(4, "error", "page.test.failed", {}, "page"));
  const { errors } = readEventErrors(dir, {});
  assert.deepEqual(errors, [
    'error host host.test.failed: {"where":"sidecar","text":"closed"}',
    "error page page.test.failed: {}",
  ]);
});

test("the events of the debug file of a process are read with its main file in the order of seq", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"),
    line(1, "info", "log.open") + line(2, "warn", "host.test.warned") + line(4, "error", "host.test.failed"));
  writeFileSync(join(dir, "logs", "host-1-10.debug.jsonl"),
    line(3, "info", "log.open") + line(5, "debug", "host.trace.mark", { event: "mark" }));
  writeFileSync(join(dir, "logs", "vt-1-20.jsonl"), line(1, "info", "log.open", {}, "sidecar"));
  const { events, offsets } = readEvents(dir, {});
  assert.deepEqual(events.map((event) => `${event.layer}:${event.seq}`), ["host:1", "host:2", "host:3", "host:4", "host:5", "sidecar:1"]);
  assert.deepEqual(Object.keys(offsets).sort(), ["host-1-10.debug.jsonl", "host-1-10.jsonl", "vt-1-20.jsonl"]);
  assert.deepEqual(Object.keys(currentEventOffsets(dir)).sort(), ["host-1-10.debug.jsonl", "host-1-10.jsonl", "vt-1-20.jsonl"]);
  appendFileSync(join(dir, "logs", "host-1-10.debug.jsonl"), line(6, "debug", "host.trace.next", { event: "next" }));
  assert.deepEqual(readEventLines(dir, offsets).lines, ["debug host host.trace.next: {\"event\":\"next\"}"]);
});

test("readEventErrors reads from the offsets of each file and leaves an unfinished line for the next read", (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(file, line(1, "error", "host.test.first") + '{"ts_us":1791000000000009,"seq":2');
  const first = readEventErrors(dir, {});
  assert.deepEqual(first.errors, ["error host host.test.first: {}"]);
  appendFileSync(file, ',"level":"error","layer":"host","event":"host.test.second","fields":{}}\n');
  const second = readEventErrors(dir, first.offsets);
  assert.deepEqual(second.errors, ["error host host.test.second: {}"]);
  assert.deepEqual(readEventErrors(dir, second.offsets).errors, []);
});

test("readEventErrors reads a file of a later run from its start", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open"));
  const first = readEventErrors(dir, {});
  writeFileSync(join(dir, "logs", "host-2-20.jsonl"), line(1, "error", "host.test.after.restart"));
  assert.deepEqual(readEventErrors(dir, first.offsets).errors, ["error host host.test.after.restart: {}"]);
});

test("readEventErrors names the file and the line of a line that is not an event", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open") + "not json\n");
  assert.throws(() => readEventErrors(dir, {}), /host-1-10\.jsonl:2: .*not valid JSON/);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open") + '{"seq":2}\n');
  assert.throws(() => readEventErrors(dir, {}), /host-1-10\.jsonl:2: .*level/);
});

test("readEventErrors names a file that is shorter than the bytes already read, and a folder without an event log", (t) => {
  const dir = configDir(t);
  assert.throws(() => readEventErrors(dir, {}), /logs holds no host event log/);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open"));
  const inode = String(statSync(join(dir, "logs", "host-1-10.jsonl"), { bigint: true }).ino);
  assert.throws(() => readEventErrors(dir, { "host-1-10.jsonl": { offset: 100000, inode } }), /host-1-10\.jsonl is shorter than the 100000 bytes already read/);
});

test("a file that the writer rotated is read on from its generation and the new file from its start", (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.debug.jsonl");
  writeFileSync(file, line(1, "info", "log.open") + line(2, "debug", "host.test.before"));
  const first = readEvents(dir, {});
  appendFileSync(file, line(3, "debug", "host.test.last"));
  // The writer moves the full file to the next generation (logging.md#files) and starts a new file, shorter than the offset.
  renameSync(file, `${file}.1`);
  writeFileSync(file, line(4, "info", "log.open") + line(5, "info", "log.rotated") + line(6, "debug", "host.test.after"));
  const second = readEvents(dir, first.offsets);
  assert.deepEqual(second.events.map((event) => event.event), ["host.test.last", "log.open", "log.rotated", "host.test.after"]);
  assert.deepEqual(second.offsets["host-1-10.debug.jsonl"], { offset: statSync(file).size, inode: String(statSync(file, { bigint: true }).ino) });
  // A rotated file whose generation is gone is an error that names the file.
  rmSync(`${file}.1`);
  assert.throws(() => readEvents(dir, first.offsets), /host-1-10\.debug\.jsonl was rotated, and no generation holds the \d+ bytes already read/);
});

test("the offsets of the event logs are kept beside the configuration folder", (t) => {
  const dir = configDir(t);
  assert.deepEqual(readEventOffsets(dir), {});
  writeEventOffsets(dir, { "host-1-10.jsonl": { offset: 42, inode: "7" } });
  assert.deepEqual(readEventOffsets(dir), { "host-1-10.jsonl": { offset: 42, inode: "7" } });
  writeFileSync(`${dir}.event-offsets`, "[1]");
  assert.throws(() => readEventOffsets(dir), /expected an object of positions \{offset, inode\}/);
  // A position of another form is refused with the file and what it found.
  writeFileSync(`${dir}.event-offsets`, `${JSON.stringify({ "host-1-10.jsonl": 42 })}\n`);
  assert.throws(() => readEventOffsets(dir), /expected an object of positions \{offset, inode\}, found \{"host-1-10\.jsonl":42\}/);
  rmSync(`${dir}.event-offsets`);
});

test("a record event reads as the line of the text form, and another event as its name and fields", () => {
  const record = { level: "error", layer: "host", event: "host.record.error", fields: { where: "page asset", text: "/missing.js: not found" } };
  assert.equal(eventLine(record), "error host page asset: /missing.js: not found");
  assert.equal(eventLine({ ...record, level: "info", event: "page.record.info", layer: "page", fields: { where: "verify", text: "18 pass" } }), "info page verify: 18 pass");
  assert.equal(eventLine({ level: "warn", layer: "host", event: "host.test.warned", fields: { index: 1 } }), 'warn host host.test.warned: {"index":1}');
  assert.throws(() => eventLine({ level: "error", layer: "host", event: "host.record.error", fields: { where: "x" } }), /where and text/);
});

test("readEventErrors prints a record event as the line of the text form", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"),
    line(1, "error", "host.record.error", { where: "page asset", text: "/missing.js: not found" }) +
    line(2, "info", "host.record.info", { where: "sidecar", text: "started" }));
  assert.deepEqual(readEventErrors(dir, {}).errors, ["error host page asset: /missing.js: not found"]);
});

test("readEventLines returns the lines of every event after the offsets", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"),
    line(1, "info", "host.record.info", { where: "sidecar", text: "started" }) + line(2, "warn", "host.test.warned", { index: 1 }));
  const first = readEventLines(dir, {});
  assert.deepEqual(first.lines, ["info host sidecar: started", 'warn host host.test.warned: {"index":1}']);
  assert.deepEqual(readEventLines(dir, first.offsets).lines, []);
});

test("untilEventLine returns the first line after the offsets that the predicate accepts, and names the lines it saw on a timeout", async (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(file, line(1, "info", "host.record.info", { where: "early", text: "before the offsets" }));
  writeFileSync(join(dir, "log-policy.json"), EVERY);
  const { offsets } = readEventLines(dir, {});
  // The file changes after the watch is installed: the record arrives while the check waits.
  setImmediate(() => appendFileSync(file, line(2, "info", "page.record.info", { where: "page", text: "focus in a" }, "page")));
  assert.equal(await untilEventLine(dir, offsets, (text) => text.endsWith("focus in a"), 5000, RECORDS), "info page page: focus in a");
  await assert.rejects(untilEventLine(dir, offsets, (text) => text.includes("never"), 100, RECORDS),
    /no event line matched within 100 ms; the lines after the offsets: \[.*focus in a/);
});

test("untilEventLines waits for a predicate over all the lines after the offsets", async (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(file, line(1, "error", "host.record.error", { where: "a", text: "first" }));
  setImmediate(() => appendFileSync(file, line(2, "error", "host.record.error", { where: "b", text: "second" })));
  const lines = await untilEventLines(dir, {}, (all) => all.filter((entry) => entry.startsWith("error ")).length >= 2, 5000,
    { catalog: CATALOG, records: ["host.record.error"] });
  assert.deepEqual(lines, ["error host a: first", "error host b: second"]);
});

test("untilEventLines sees a record that another process appends to an existing file", async (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(file, line(1, "info", "log.open"));
  writeFileSync(join(dir, "log-policy.json"), EVERY);
  const { offsets } = readEventLines(dir, {});
  // The writer of the application is another process: it appends to its file after the check started to wait (the child
  // process takes longer to start than the check takes to install its watchers), and no entry of the folder changes.
  const appender = spawn(process.execPath, ["-e", `
    const { appendFileSync } = require("node:fs");
    appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(line(2, "info", "host.record.info", { where: "w", text: "appended" }))});
  `], { stdio: "inherit" });
  t.after(() => appender.kill());
  const lines = await untilEventLines(dir, offsets, (all) => all.includes("info host w: appended"), 3000, RECORDS);
  assert.deepEqual(lines, ["info host w: appended"]);
});

test("untilEventLines sees a file that another process creates", async (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open"));
  writeFileSync(join(dir, "log-policy.json"), EVERY);
  const { offsets } = readEventLines(dir, {});
  const creator = spawn(process.execPath, ["-e", `
    const { writeFileSync } = require("node:fs");
    writeFileSync(${JSON.stringify(join(dir, "logs", "host-2-20.jsonl"))}, ${JSON.stringify(line(1, "info", "host.record.info", { where: "w", text: "new file" }))});
  `], { stdio: "inherit" });
  t.after(() => creator.kill());
  const lines = await untilEventLines(dir, offsets, (all) => all.includes("info host w: new file"), 3000, RECORDS);
  assert.deepEqual(lines, ["info host w: new file"]);
});

test("traceRows turns the events of the trace of the page, the host and the sampler into rows with the layer, the event, the time and the fields", () => {
  const events = [
    { ts_us: 1791000000123456, level: "debug", layer: "page", event: "page.trace.surface.registration", fields: { phase: "registered", name: "core.x" } },
    { ts_us: 1791000000200000, level: "info", layer: "host", event: "host.record.info", fields: { where: "w", text: "t" } },
    { ts_us: 1791000000300000, level: "debug", layer: "page", event: "page.trace.action", fields: { kind: "resize" } },
    { ts_us: 1791000000400000, level: "debug", layer: "host", event: "host.trace.sidecar.send", fields: { surface: "tab-1" } },
    { ts_us: 1791000000500000, level: "debug", layer: "host", event: "host.sampler.memory", fields: { rss_host_kb: 42 } },
  ];
  assert.deepEqual(traceRows(events), [
    { layer: "page", event: "surface.registration", ts: "2026-10-03T04:00:00.123Z", phase: "registered", name: "core.x" },
    { layer: "page", event: "action", ts: "2026-10-03T04:00:00.300Z", kind: "resize" },
    { layer: "host", event: "sidecar.send", ts: "2026-10-03T04:00:00.400Z", surface: "tab-1" },
    { layer: "sampler", event: "memory", ts: "2026-10-03T04:00:00.500Z", rss_host_kb: 42 },
  ]);
});

test("currentEventOffsets is the end of the complete lines of every host event log, not the offsets that were stored", (t) => {
  const dir = configDir(t);
  const first = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(first, line(1, "info", "log.open") + line(2, "info", "host.record.info", { where: "a", text: "b" }) + '{"ts_us":1,"seq":3');
  writeEventOffsets(dir, { "host-1-10.jsonl": { offset: 5, inode: "7" } });
  const now = currentEventOffsets(dir);
  assert.deepEqual(Object.keys(now), ["host-1-10.jsonl"]);
  assert.equal(now["host-1-10.jsonl"].offset, Buffer.byteLength(line(1, "info", "log.open") + line(2, "info", "host.record.info", { where: "a", text: "b" })));
  assert.deepEqual(readEventLines(dir, now).lines, [], "nothing is after the end");
  appendFileSync(first, ',"level":"info","layer":"host","event":"host.record.info","fields":{"where":"c","text":"d"}}\n');
  assert.deepEqual(readEventLines(dir, now).lines, ["info host c: d"], "the unfinished line is read once it is complete");
});

test("the event file of a sidecar is read with the files of the host, and its events become rows with the surface, the session and the cids", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open", { schema: 2 }) + line(2, "error", "host.test.failed", { where: "w", text: "t" }));
  const sidecar = (seq, event, fields, extra = {}) =>
    `${JSON.stringify({ ts_us: 1791000000000000 + seq, seq, level: "info", layer: "sidecar", event, fields, ...extra })}\n`;
  writeFileSync(join(dir, "logs", "vt-1-11.jsonl"),
    sidecar(1, "log.open", { schema: 2, pid: 11, role: "vt", boot: "1-11" }) +
    sidecar(2, "sidecar.vt.pty_write", { bytes: 1, hex: "0d", text: "\r", ok: true }, { session: "s-1", cids: ["b1.7"] }) +
    sidecar(3, "sidecar.vt.request", { operation: "input", body: { surface: "tab-1" } }, { surface: "tab-1" }));
  const { events, errors } = readEventErrors(dir, {});
  assert.deepEqual(errors, ['error host host.test.failed: {"where":"w","text":"t"}']);
  const rows = traceRows(readEvents(dir, {}).events);
  assert.deepEqual(rows.map(({ layer, event, surface, session, cids, hex }) => ({ layer, event, surface, session, cids, hex })), [
    { layer: "vt-core", event: "pty_write", surface: undefined, session: "s-1", cids: ["b1.7"], hex: "0d" },
    { layer: "vt-core", event: "request", surface: "tab-1", session: undefined, cids: undefined, hex: undefined },
  ]);
});

test("without stored offsets the session starts at the end of the files of ended processes and at the start of the running one", (t) => {
  const dir = configDir(t);
  // An earlier process left an error; the running process 20 writes its own.
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "error", "host.test.earlier"));
  writeFileSync(join(dir, "logs", "host-2-20.jsonl"), line(1, "error", "host.test.current"));
  const { errors } = readEventErrors(dir, sessionEventStart(dir, 20));
  assert.deepEqual(errors, ["error host host.test.current: {}"]);
});

test("stored offsets are the start of the session", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "error", "host.test.read"));
  writeEventOffsets(dir, readEventErrors(dir, {}).offsets);
  appendFileSync(join(dir, "logs", "host-1-10.jsonl"), line(2, "error", "host.test.after"));
  assert.deepEqual(readEventErrors(dir, sessionEventStart(dir, 10)).errors, ["error host host.test.after: {}"]);
});

// F192.3-2: a wait on a record that the log policy of the folder does not store fails at once with an error that names the
// record and the policy, instead of waiting until the deadline.
test("untilEventLines rejects at once a record that the policy of the folder does not store", async (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open"));
  const started = performance.now();
  await assert.rejects(untilEventLines(dir, {}, () => false, 3000, { catalog: CATALOG, records: ["sidecar.vt.frame"] }),
    { message: "the check reads sidecar.vt.frame (class frame, level debug), which the log policy " +
      `{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"} of ${join(dir, "log-policy.json")} does not store` });
  assert.ok(performance.now() - started < 1000, `the rejection took ${Math.round(performance.now() - started)} ms`);
});

test("untilEventLines waits on a record that the policy file of the folder stores", async (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "log-policy.json"),
    JSON.stringify({ schema: 1, classes: { lifecycle: "info", input: "error", call: "error", io: "error", frame: "error" } }));
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "host.record.info", { where: "run", text: "a" }));
  const lines = await untilEventLines(dir, {}, (all) => all.length === 1, 3000, { catalog: CATALOG, records: ["host.record.info"] });
  assert.deepEqual(lines, ["info host run: a"]);
});

test("untilEventLines refuses a wait that names no record", async (t) => {
  const dir = configDir(t);
  await assert.rejects(untilEventLines(dir, {}, () => true, 3000),
    { message: "untilEventLines: the wait names no record; give { catalog, records } of the records that the predicate reads" });
});

test("untilEventLines waits on an event that passes every gate under the default policy", async (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "page.start", { url: "a" }, "page"));
  const lines = await untilEventLines(dir, {}, (all) => all.length === 1, 3000, { catalog: CATALOG, records: ["page.start"] });
  assert.deepEqual(lines, ['info page page.start: {"url":"a"}']);
});
