// 창 검사가 애플리케이션의 event log(docs/spec/logging.md#files)에서 검사 동안 쓰인 오류 event를 읽는지 검사한다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { currentEventOffsets, eventLine, traceRows, readEventErrors, readEventLines, readEventOffsets, untilEventLine, untilEventLines, writeEventOffsets } from "../event-log.mjs";

function configDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "soksak-event-log-"));
  t.after(() => rmSync(dir, { recursive: true }));
  mkdirSync(join(dir, "logs"));
  return dir;
}

const line = (seq, level, event, fields = {}, layer = "host") =>
  `${JSON.stringify({ ts_us: 1791000000000000 + seq, seq, level, layer, event, fields })}\n`;

test("readEventErrors returns the events of level error and ignores the other levels", (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"),
    line(1, "info", "log.open", { schema: 1 }) + line(2, "warn", "host.test.warned") +
    line(3, "error", "host.test.failed", { where: "sidecar", text: "closed" }) + line(4, "error", "page.test.failed", {}, "page"));
  const { errors } = readEventErrors(dir, {});
  assert.deepEqual(errors, [
    'error host host.test.failed: {"where":"sidecar","text":"closed"}',
    "error page page.test.failed: {}",
  ]);
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
  assert.throws(() => readEventErrors(dir, { "host-1-10.jsonl": 100000 }), /host-1-10\.jsonl is shorter than the 100000 bytes already read/);
});

test("the offsets of the event logs are kept beside the configuration folder", (t) => {
  const dir = configDir(t);
  assert.deepEqual(readEventOffsets(dir), {});
  writeEventOffsets(dir, { "host-1-10.jsonl": 42 });
  assert.deepEqual(readEventOffsets(dir), { "host-1-10.jsonl": 42 });
  writeFileSync(`${dir}.event-offsets`, "[1]");
  assert.throws(() => readEventOffsets(dir), /expected an object of byte offsets/);
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
  const { offsets } = readEventLines(dir, {});
  // The file changes after the watch is installed: the record arrives while the check waits.
  setImmediate(() => appendFileSync(file, line(2, "info", "page.record.info", { where: "page", text: "focus in a" }, "page")));
  assert.equal(await untilEventLine(dir, offsets, (text) => text.endsWith("focus in a"), 5000), "info page page: focus in a");
  await assert.rejects(untilEventLine(dir, offsets, (text) => text.includes("never"), 100),
    /no event line matched within 100 ms; the lines after the offsets: \[.*focus in a/);
});

test("untilEventLines waits for a predicate over all the lines after the offsets", async (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(file, line(1, "error", "host.record.error", { where: "a", text: "first" }));
  setImmediate(() => appendFileSync(file, line(2, "error", "host.record.error", { where: "b", text: "second" })));
  const lines = await untilEventLines(dir, {}, (all) => all.filter((entry) => entry.startsWith("error ")).length >= 2, 5000);
  assert.deepEqual(lines, ["error host a: first", "error host b: second"]);
});

test("untilEventLines sees a record that another process appends to an existing file", async (t) => {
  const dir = configDir(t);
  const file = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(file, line(1, "info", "log.open"));
  const { offsets } = readEventLines(dir, {});
  // The writer of the application is another process: it appends to its file after the check started to wait (the child
  // process takes longer to start than the check takes to install its watchers), and no entry of the folder changes.
  const appender = spawn(process.execPath, ["-e", `
    const { appendFileSync } = require("node:fs");
    appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(line(2, "info", "host.record.info", { where: "w", text: "appended" }))});
  `], { stdio: "inherit" });
  t.after(() => appender.kill());
  const lines = await untilEventLines(dir, offsets, (all) => all.includes("info host w: appended"), 3000);
  assert.deepEqual(lines, ["info host w: appended"]);
});

test("untilEventLines sees a file that another process creates", async (t) => {
  const dir = configDir(t);
  writeFileSync(join(dir, "logs", "host-1-10.jsonl"), line(1, "info", "log.open"));
  const { offsets } = readEventLines(dir, {});
  const creator = spawn(process.execPath, ["-e", `
    const { writeFileSync } = require("node:fs");
    writeFileSync(${JSON.stringify(join(dir, "logs", "host-2-20.jsonl"))}, ${JSON.stringify(line(1, "info", "host.record.info", { where: "w", text: "new file" }))});
  `], { stdio: "inherit" });
  t.after(() => creator.kill());
  const lines = await untilEventLines(dir, offsets, (all) => all.includes("info host w: new file"), 3000);
  assert.deepEqual(lines, ["info host w: new file"]);
});

test("traceRows turns the events page.trace.<event> into rows with the layer, the event, the time and the fields", () => {
  const events = [
    { ts_us: 1791000000123456, level: "debug", layer: "page", event: "page.trace.surface.registration", fields: { phase: "registered", name: "core.x" } },
    { ts_us: 1791000000200000, level: "info", layer: "host", event: "host.record.info", fields: { where: "w", text: "t" } },
    { ts_us: 1791000000300000, level: "debug", layer: "page", event: "page.trace.action", fields: { kind: "resize" } },
  ];
  assert.deepEqual(traceRows(events), [
    { layer: "page", event: "surface.registration", ts: "2026-10-03T04:00:00.123Z", phase: "registered", name: "core.x" },
    { layer: "page", event: "action", ts: "2026-10-03T04:00:00.300Z", kind: "resize" },
  ]);
});

test("currentEventOffsets is the end of the complete lines of every host event log, not the offsets that were stored", (t) => {
  const dir = configDir(t);
  const first = join(dir, "logs", "host-1-10.jsonl");
  writeFileSync(first, line(1, "info", "log.open") + line(2, "info", "host.record.info", { where: "a", text: "b" }) + '{"ts_us":1,"seq":3');
  writeEventOffsets(dir, { "host-1-10.jsonl": 5 });
  const now = currentEventOffsets(dir);
  assert.deepEqual(Object.keys(now), ["host-1-10.jsonl"]);
  assert.equal(now["host-1-10.jsonl"], Buffer.byteLength(line(1, "info", "log.open") + line(2, "info", "host.record.info", { where: "a", text: "b" })));
  assert.deepEqual(readEventLines(dir, now).lines, [], "nothing is after the end");
  appendFileSync(first, ',"level":"info","layer":"host","event":"host.record.info","fields":{"where":"c","text":"d"}}\n');
  assert.deepEqual(readEventLines(dir, now).lines, ["info host c: d"], "the unfinished line is read once it is complete");
});
