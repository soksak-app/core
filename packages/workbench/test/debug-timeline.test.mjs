// The timeline of the debug view orders the rows of the pages that the host answers, builds the request of the query for a filter,
// and renders a row as the text line that `sok debug query` prints (docs/spec/debug.md, docs/spec/logging.md#query).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { CLEAR_FILTER, HOLD_LIMIT, PAGE_ROWS, compareRows, eventLine, isEventFile, keyOf, mergeRows, queryOf, rowId } from "../debug-timeline.js";

const FIXTURES = new URL("../../log-contract/fixtures/query/", import.meta.url);

/** The rows of the golden event files by the identity `<role>-<boot>:<seq>` that cases.json uses. */
function goldenRows() {
  const rows = new Map();
  for (const name of readdirSync(new URL("logs/", FIXTURES))) {
    const match = /^([a-z]+)-(.+?)(?:\.debug)?\.jsonl(?:\.\d)?$/.exec(name);
    if (match === null) continue;
    for (const text of readFileSync(new URL(`logs/${name}`, FIXTURES), "utf8").trim().split("\n")) {
      const event = JSON.parse(text);
      rows.set(`${match[1]}-${match[2]}:${event.seq}`, { role: match[1], boot: match[2], file: `logs/${name}`, offset: 0, event });
    }
  }
  return rows;
}

const row = (role, boot, seq, ts_us, extra = {}) => ({ role, boot, file: `logs/${role}-${boot}.jsonl`, offset: 0, event: { ts_us, seq, level: "info", layer: "host", event: "host.x.y", ...extra } });

test("a row is one text line with the time in microseconds, the identifiers and the fields", () => {
  const event = { ts_us: 1791500000123456, seq: 9, level: "error", layer: "native", event: "native.input.key_down", window: "w1", surface: "tab-x", session: "s7", cids: ["b3.1", "b3.2"], fields: { keyCode: 36, characters: "\r" } };
  assert.equal(eventLine(event), '2026-10-08T22:53:20.123456Z error native native.input.key_down window=w1 surface=tab-x session=s7 cids=b3.1,b3.2 keyCode=36 characters="\\r"');
  assert.equal(eventLine({ ts_us: 5, seq: 1, level: "info", layer: "sok", event: "sok.command", cids: [] }), "1970-01-01T00:00:00.000005Z info sok sok.command");
});

test("the text line of each golden page is the line that the implementations of sok print", () => {
  const rows = goldenRows();
  const cases = JSON.parse(readFileSync(new URL("cases.json", FIXTURES), "utf8"));
  assert.ok(cases.length >= 25);
  for (const { name, rows: ids, lines } of cases) {
    assert.deepEqual(ids.map((id) => eventLine(rows.get(id).event)), lines, name);
  }
});

test("rows are ordered by the key of the query: time, then role, then boot, then seq, and each row once", () => {
  const a = [row("host", "b1", 2, 20), row("host", "b1", 1, 20), row("vt", "v1", 1, 20)];
  const b = [row("host", "b1", 2, 20), row("host", "b0", 9, 20), row("host", "b1", 3, 10)];
  assert.deepEqual(mergeRows(a, b).map(rowId), ["host-b1:3", "host-b0:9", "host-b1:1", "host-b1:2", "vt-v1:1"]);
  assert.deepEqual(keyOf(a[0]), { ts_us: 20, role: "host", boot: "b1", seq: 2 });
  assert.ok(compareRows(a[1], a[0]) < 0 && compareRows(a[0], a[2]) < 0 && compareRows(a[0], a[0]) === 0);
  assert.deepEqual(a.map(rowId), ["host-b1:2", "host-b1:1", "vt-v1:1"], "the arguments are not changed");
});

test("the event files are the files of the logs folder that the query reads", () => {
  for (const path of ["logs/host-1-2.jsonl", "logs/host-1-2.jsonl.3", "logs/host-1-2.debug.jsonl", "logs/host-1-2.debug.jsonl.5", "logs/vt-v1.jsonl", "logs/sok-s1.jsonl"]) assert.ok(isEventFile(path), path);
  for (const path of ["logs/host-1-2.jsonl.6", "logs/host-1-2.jsonl.idx", "logs/host-1-2.stderr", "logs/state-20261009T010203Z.json", "logs/captures/host-x.jsonl", "plugins/host-a.jsonl", "logs/application.log"]) assert.equal(isEventFile(path), false, path);
});

test("the request of the query leaves the open members out and turns the UTC times into microseconds", () => {
  assert.deepEqual(queryOf({ ...CLEAR_FILTER }), { channel: "other", level: "trace" });
  assert.deepEqual(queryOf({ ...CLEAR_FILTER, channel: "all", level: "warn", layer: "page", class: "input", text: "boom", event_prefix: "page.call", surface: "tab-x", session: "s1", cid: "b1.1", run: "r1" }),
    { channel: "all", level: "warn", layer: "page", class: "input", text: "boom", event_prefix: "page.call", surface: "tab-x", session: "s1", cid: "b1.1", run: "r1" });
  assert.deepEqual(queryOf({ ...CLEAR_FILTER, event: "page.call", from: "2026-10-08T22:53:20Z", to: "2026-10-08T22:53:20.123456Z" }),
    { channel: "other", level: "trace", event: "page.call", from_us: 1791500000000000, to_us: 1791500000123456 });
  assert.throws(() => queryOf({ ...CLEAR_FILTER, from: "yesterday" }), /log query from "yesterday" is not a UTC time like 2026-10-08T22:53:20\.123456Z/);
  assert.throws(() => queryOf({ ...CLEAR_FILTER, to: "2026-02-30T00:00:00Z" }), /log query to "2026-02-30T00:00:00Z" is not a UTC time like/);
  assert.throws(() => queryOf({ ...CLEAR_FILTER, text: 3 }), /log query text must be a string, found 3/);
});

test("a page is 500 rows and the view holds 2000", () => {
  assert.equal(PAGE_ROWS, 500);
  assert.equal(HOLD_LIMIT, 2000);
});
