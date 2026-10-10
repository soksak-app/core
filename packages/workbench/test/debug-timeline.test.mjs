// The timeline of the debug view merges the event lines of the host event files and filters them
// (docs/spec/debug.md, docs/spec/logging.md).
import assert from "node:assert/strict";
import test from "node:test";

import { CLEAR_FILTER, contextRows, eventLine, filterRows, hostEventFiles, mergeRows, parseAppended, parseEvents } from "../debug-timeline.js";

const line = (event) => JSON.stringify(event);
const open = (boot, ts_us = 1) => line({ ts_us, seq: 0, level: "info", layer: "host", event: "log.open", fields: { schema: 1, boot } });
const event = (ts_us, seq, level, layer, name, extra = {}) => line({ ts_us, seq, level, layer, event: name, ...extra });

test("the lines of a file become rows in the order of the file and the log.open line is kept", () => {
  const text = [open("b1"), event(10, 1, "info", "host", "host.window.created", { window: "w1", fields: { id: 3 } })].join("\n") + "\n";
  const rows = parseEvents("logs/host-b1.jsonl", text);
  assert.deepEqual(rows.map((row) => [row.file, row.seq, row.event]), [["logs/host-b1.jsonl", 0, "log.open"], ["logs/host-b1.jsonl", 1, "host.window.created"]]);
  assert.equal(rows[1].window, "w1");
});

test("a file that does not follow the event contract is rejected with its name and what was found", () => {
  const bad = (text, expected) => assert.throws(() => parseEvents("logs/host-b1.jsonl", text), expected);
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

test("appended lines become rows numbered after the lines read before and need no log.open", () => {
  const text = `${event(10, 7, "warn", "page", "page.call.slow")}\n${event(11, 8, "info", "host", "host.app.event")}\n`;
  const rows = parseAppended("logs/host-b1.jsonl", text, 5);
  assert.deepEqual(rows.map((row) => [row.file, row.line, row.seq]), [["logs/host-b1.jsonl", 5, 7], ["logs/host-b1.jsonl", 6, 8]]);
  assert.deepEqual(parseAppended("logs/host-b1.jsonl", "", 5), []);
});

test("an appended line that is not an event is rejected with the file and its line number", () => {
  const text = `${event(10, 7, "warn", "page", "page.call.slow")}\nnot json\n`;
  assert.throws(() => parseAppended("logs/host-b1.jsonl", text, 5), /logs\/host-b1\.jsonl:6: not JSON: not json/);
  assert.throws(() => parseAppended("logs/host-b1.jsonl", `${event(5, 1, "loud", "host", "x.y.z")}\n`, 9), /logs\/host-b1\.jsonl:9: level "loud" is not one of/);
});

test("rows of several files are merged by time, then seq, then file", () => {
  const a = parseEvents("logs/host-a.jsonl", [open("a"), event(30, 2, "info", "host", "a.b.c"), event(20, 1, "info", "host", "a.b.c")].join("\n"));
  const b = parseEvents("logs/host-b.jsonl", [open("b", 2), event(20, 1, "error", "page", "b.b.c"), event(25, 2, "info", "page", "b.b.c")].join("\n"));
  const merged = mergeRows([a, b]);
  assert.deepEqual(merged.map((row) => `${row.ts_us}/${row.seq}/${row.file.slice(-7, -6)}`), ["1/0/a", "2/0/b", "20/1/a", "20/1/b", "25/2/b", "30/2/a"]);
});

test("a row is one text line with the time in microseconds, the identifiers and the fields", () => {
  const text = [open("b1"), event(1791500000123456, 9, "error", "native", "native.input.key_down", { window: "w1", surface: "tab-x", session: "s7", cids: ["b3.1", "b3.2"], fields: { keyCode: 36, characters: "\r" } })].join("\n");
  const rows = parseEvents("logs/host-b1.jsonl", text);
  assert.equal(eventLine(rows[1]), '2026-10-08T22:53:20.123456Z error native native.input.key_down window=w1 surface=tab-x session=s7 cids=b3.1,b3.2 keyCode=36 characters="\\r"');
});

test("rows are filtered by the least level, the layer and a case-insensitive text", () => {
  const text = [
    open("b1"),
    event(10, 1, "debug", "host", "host.window.created", { fields: { title: "Alpha" } }),
    event(11, 2, "warn", "page", "page.call.slow", { fields: { name: "windows.list" } }),
    event(12, 3, "error", "native", "native.input.key_down"),
  ].join("\n");
  const rows = parseEvents("logs/host-b1.jsonl", text);
  const seqs = (filter) => filterRows(rows, filter).map((row) => row.seq);
  assert.deepEqual(seqs({ ...CLEAR_FILTER }), [0, 1, 2, 3]);
  assert.deepEqual(seqs({ ...CLEAR_FILTER, level: "warn", layer: "all", text: "" }), [2, 3]);
  assert.deepEqual(seqs({ ...CLEAR_FILTER, level: "trace", layer: "page", text: "" }), [2]);
  assert.deepEqual(seqs({ ...CLEAR_FILTER, level: "trace", layer: "all", text: "ALPHA" }), [1]);
  assert.deepEqual(seqs({ ...CLEAR_FILTER, level: "info", layer: "all", text: "alpha" }), []);
  assert.throws(() => filterRows(rows, { ...CLEAR_FILTER, level: "loud", layer: "all", text: "" }), /timeline level "loud" is not one of/);
  assert.throws(() => filterRows(rows, { ...CLEAR_FILTER, level: "trace", layer: "kernel", text: "" }), /timeline layer "kernel" is not one of/);
  assert.throws(() => filterRows(rows, { ...CLEAR_FILTER, level: "trace", layer: "all", text: 3 }), /timeline text must be a string, found 3/);
});

test("the event files of the host are the listed logs/host-<boot>.jsonl files in path order", () => {
  const paths = ["logs/host-b.jsonl", "logs/host-a.jsonl", "logs/host-a.jsonl.1", "logs/sidecar-a.jsonl", "logs/application.log", "logs/captures/host-x.jsonl"];
  assert.deepEqual(hostEventFiles(paths.map((path) => ({ path, size: 1, modified: 1 }))), ["logs/host-a.jsonl", "logs/host-b.jsonl"]);
});

const identified = () => parseEvents("logs/host-b1.jsonl", [
  open("b1"),
  event(1791500000000000, 1, "info", "host", "host.window.created", { window: "w1", surface: "tab-a", session: "s1", cids: ["c1"] }),
  event(1791500001000000, 2, "info", "page", "page.call.begin", { surface: "tab-a", session: "s1", cids: ["c1", "c2"] }),
  event(1791500002000000, 3, "warn", "page", "page.call.slow", { surface: "tab-b", session: "s2", cids: ["c2"] }),
  event(1791500003000000, 4, "info", "native", "native.input.key_down", { surface: "tab-b" }),
  event(1791500004000000, 5, "info", "host", "host.window.closed", { window: "w1" }),
].join("\n"));

test("rows are filtered by event name, surface, session, correlation identifier and time range", () => {
  const rows = identified();
  const seqs = (change) => filterRows(rows, { ...CLEAR_FILTER, ...change }).map((row) => row.seq);
  assert.deepEqual(seqs({ event: "PAGE.CALL" }), [2, 3]);
  assert.deepEqual(seqs({ surface: "tab-a" }), [1, 2]);
  assert.deepEqual(seqs({ surface: "tab" }), []);
  assert.deepEqual(seqs({ session: "s2" }), [3]);
  assert.deepEqual(seqs({ cid: "c2" }), [2, 3]);
  assert.deepEqual(seqs({ cid: "c" }), []);
  assert.deepEqual(seqs({ from: "2026-10-08T22:53:21Z", to: "2026-10-08T22:53:22.000000Z" }), [2, 3]);
  assert.deepEqual(seqs({ from: "2026-10-08T22:53:23Z" }), [4, 5]);
  assert.deepEqual(seqs({ to: "2026-10-08T22:53:20.999999Z" }), [0, 1]);
  assert.deepEqual(seqs({ surface: "tab-b", cid: "c2", event: "slow" }), [3]);
});

test("invalid event, surface, session, correlation identifier, time and context values are rejected", () => {
  const rows = identified();
  const bad = (change, expected) => assert.throws(() => filterRows(rows, { ...CLEAR_FILTER, ...change }), expected);
  bad({ event: 3 }, /timeline event must be a string, found 3/);
  bad({ surface: null }, /timeline surface must be a string, found null/);
  bad({ session: 1 }, /timeline session must be a string, found 1/);
  bad({ cid: [] }, /timeline cid must be a string, found \[\]/);
  bad({ from: "yesterday" }, /timeline from "yesterday" is not a UTC time like 2026-10-08T22:53:20\.123456Z or empty/);
  bad({ to: "2026-10-08 22:53:20Z" }, /timeline to "2026-10-08 22:53:20Z" is not a UTC time/);
  bad({ from: "2026-02-30T00:00:00Z" }, /timeline from "2026-02-30T00:00:00Z" is not a UTC time/);
  bad({ from: "2026-10-08T22:53:22Z", to: "2026-10-08T22:53:21Z" }, /timeline from is later than to/);
  bad({ context: 2 }, /timeline context must be decimal digits, found 2/);
  bad({ context: "-1" }, /timeline context must be decimal digits, found "-1"/);
  bad({ context: "12345" }, /timeline context must be decimal digits, found "12345"/);
});

test("context rows add the rows before and after each row that passes, once, marked as context", () => {
  const rows = identified();
  const shape = (change) => contextRows(rows, { ...CLEAR_FILTER, ...change }).map((entry) => `${entry.row.seq}${entry.match ? "*" : ""}`);
  assert.deepEqual(shape({ event: "slow" }), ["3*"]);
  assert.deepEqual(shape({ event: "slow", context: "1" }), ["2", "3*", "4"]);
  assert.deepEqual(shape({ event: "page.call", context: "1" }), ["1", "2*", "3*", "4"]);
  assert.deepEqual(shape({ event: "log.open", context: "2" }), ["0*", "1", "2"]);
  assert.deepEqual(shape({ event: "closed", context: "9" }), ["0", "1", "2", "3", "4", "5*"]);
  assert.deepEqual(shape({ event: "nothing", context: "3" }), []);
});

// The golden files of `sok debug timeline` (docs/spec/debug.md#timeline-command): the files and the expected lines of each filter,
// which the view, `sok` for Go and `sok` for Rust all produce.
test("the golden files give the lines that `sok debug timeline` prints for each filter", async () => {
  const { readFileSync } = await import("node:fs");
  const folder = new URL("../../log-contract/fixtures/timeline/", import.meta.url);
  const rows = mergeRows(["host-b1.jsonl", "host-b2.jsonl"].map((name) => parseEvents(`logs/${name}`, readFileSync(new URL(`logs/${name}`, folder), "utf8"))));
  const cases = JSON.parse(readFileSync(new URL("cases.json", folder), "utf8"));
  assert.ok(cases.length >= 7);
  for (const { name, args, lines } of cases) {
    const filter = { ...CLEAR_FILTER };
    for (let index = 0; index < args.length; index += 2) filter[args[index].slice(2)] = args[index + 1];
    const printed = contextRows(rows, filter).map(({ row, match }) => (match || Number(filter.context) === 0 ? "" : "  ") + eventLine(row));
    assert.deepEqual(printed, lines, name);
  }
});
