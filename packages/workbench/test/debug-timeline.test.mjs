// The timeline of the debug view merges the event lines of the host event files and filters them
// (docs/spec/debug.md, docs/spec/logging.md).
import assert from "node:assert/strict";
import test from "node:test";

import { eventLine, filterRows, hostEventFiles, mergeRows, parseEvents } from "../debug-timeline.js";

const line = (event) => JSON.stringify(event);
const open = (boot, ts_us = 1) => line({ ts_us, seq: 0, level: "info", layer: "host", event: "log.open", fields: { schema: 1, boot } });
const event = (ts_us, seq, level, layer, name, extra = {}) => line({ ts_us, seq, level, layer, event: name, ...extra });

test("the lines of a file become rows in the order of the file and the log.open line is kept", () => {
  const text = [open("b1"), event(10, 1, "info", "host", "host.window.created", { window: "w1", fields: { id: 3 } })].join("\n") + "\n";
  const rows = parseEvents("logs/host-b1.jsonl", text, false);
  assert.deepEqual(rows.map((row) => [row.file, row.seq, row.event]), [["logs/host-b1.jsonl", 0, "log.open"], ["logs/host-b1.jsonl", 1, "host.window.created"]]);
  assert.equal(rows[1].window, "w1");
});

test("a file that does not follow the event contract is rejected with its name and what was found", () => {
  const bad = (text, expected) => assert.throws(() => parseEvents("logs/host-b1.jsonl", text, false), expected);
  bad("", /logs\/host-b1\.jsonl: the file is empty/);
  bad(`${event(1, 0, "info", "host", "host.window.created")}\n`, /logs\/host-b1\.jsonl: the first line is not log\.open: "host\.window\.created"/);
  bad(`${line({ ts_us: 1, seq: 0, level: "info", layer: "host", event: "log.open", fields: { schema: 2 } })}\n`, /logs\/host-b1\.jsonl: schema 2 is not 1/);
  bad(`${open("b1")}\nnot json\n`, /logs\/host-b1\.jsonl:2: not JSON: not json/);
  bad(`${open("b1")}\n[1]\n`, /logs\/host-b1\.jsonl:2: not an event object: \[1\]/);
  bad(`${open("b1")}\n${event(5, 1, "loud", "host", "x.y.z")}\n`, /logs\/host-b1\.jsonl:2: level "loud" is not one of/);
  bad(`${open("b1")}\n${event(5, 1, "info", "kernel", "x.y.z")}\n`, /logs\/host-b1\.jsonl:2: layer "kernel" is not one of/);
  bad(`${open("b1")}\n${event(5.5, 1, "info", "host", "x.y.z")}\n`, /logs\/host-b1\.jsonl:2: ts_us must be an integer, found 5\.5/);
  bad(`${open("b1")}\n${line({ ts_us: 5, seq: "1", level: "info", layer: "host", event: "x.y.z" })}\n`, /logs\/host-b1\.jsonl:2: seq must be an integer, found "1"/);
  bad(`${open("b1")}\n${line({ ts_us: 5, seq: 1, level: "info", layer: "host", event: 7 })}\n`, /logs\/host-b1\.jsonl:2: event must be a string, found 7/);
  bad(`${open("b1")}\n${event(5, 1, "info", "host", "x.y.z", { fields: [1] })}\n`, /logs\/host-b1\.jsonl:2: fields must be an object, found \[1\]/);
});

test("a truncated file starts after its partial first line and is not required to start with log.open", () => {
  const text = `lf":1}}\n${event(10, 7, "warn", "page", "page.call.slow")}\n`;
  const rows = parseEvents("logs/host-b1.jsonl", text, true);
  assert.deepEqual(rows.map((row) => row.seq), [7]);
  assert.throws(() => parseEvents("logs/host-b1.jsonl", "no newline at all", true), /logs\/host-b1\.jsonl: the truncated text has no complete line/);
});

test("rows of several files are merged by time, then seq, then file", () => {
  const a = parseEvents("logs/host-a.jsonl", [open("a"), event(30, 2, "info", "host", "a.b.c"), event(20, 1, "info", "host", "a.b.c")].join("\n"), false);
  const b = parseEvents("logs/host-b.jsonl", [open("b", 2), event(20, 1, "error", "page", "b.b.c"), event(25, 2, "info", "page", "b.b.c")].join("\n"), false);
  const merged = mergeRows([a, b]);
  assert.deepEqual(merged.map((row) => `${row.ts_us}/${row.seq}/${row.file.slice(-7, -6)}`), ["1/0/a", "2/0/b", "20/1/a", "20/1/b", "25/2/b", "30/2/a"]);
});

test("a row is one text line with the time in microseconds, the identifiers and the fields", () => {
  const text = [open("b1"), event(1791500000123456, 9, "error", "native", "native.input.key_down", { window: "w1", surface: "tab-x", session: "s7", cids: ["b3.1", "b3.2"], fields: { keyCode: 36, characters: "\r" } })].join("\n");
  const rows = parseEvents("logs/host-b1.jsonl", text, false);
  assert.equal(eventLine(rows[1]), '2026-10-08T22:53:20.123456Z error native native.input.key_down window=w1 surface=tab-x session=s7 cids=b3.1,b3.2 keyCode=36 characters="\\r"');
});

test("rows are filtered by the least level, the layer and a case-insensitive text", () => {
  const text = [
    open("b1"),
    event(10, 1, "debug", "host", "host.window.created", { fields: { title: "Alpha" } }),
    event(11, 2, "warn", "page", "page.call.slow", { fields: { name: "windows.list" } }),
    event(12, 3, "error", "native", "native.input.key_down"),
  ].join("\n");
  const rows = parseEvents("logs/host-b1.jsonl", text, false);
  const seqs = (filter) => filterRows(rows, filter).map((row) => row.seq);
  assert.deepEqual(seqs({ level: "trace", layer: "all", text: "" }), [0, 1, 2, 3]);
  assert.deepEqual(seqs({ level: "warn", layer: "all", text: "" }), [2, 3]);
  assert.deepEqual(seqs({ level: "trace", layer: "page", text: "" }), [2]);
  assert.deepEqual(seqs({ level: "trace", layer: "all", text: "ALPHA" }), [1]);
  assert.deepEqual(seqs({ level: "info", layer: "all", text: "alpha" }), []);
  assert.throws(() => filterRows(rows, { level: "loud", layer: "all", text: "" }), /timeline level "loud" is not one of/);
  assert.throws(() => filterRows(rows, { level: "trace", layer: "kernel", text: "" }), /timeline layer "kernel" is not one of/);
  assert.throws(() => filterRows(rows, { level: "trace", layer: "all", text: 3 }), /timeline text must be a string, found 3/);
});

test("the event files of the host are the listed logs/host-<boot>.jsonl files in path order", () => {
  const paths = ["logs/host-b.jsonl", "logs/host-a.jsonl", "logs/host-a.jsonl.1", "logs/sidecar-a.jsonl", "logs/application.log", "logs/captures/host-x.jsonl"];
  assert.deepEqual(hostEventFiles(paths.map((path) => ({ path, size: 1, modified: 1 }))), ["logs/host-a.jsonl", "logs/host-b.jsonl"]);
});
