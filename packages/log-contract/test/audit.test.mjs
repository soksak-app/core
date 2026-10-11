// The audit of the logs that tests leave (docs/spec/logging.md#checking).
import assert from "node:assert/strict";
import test from "node:test";

import { auditLog, parseLog } from "../index.js";

const catalog = {
  schema: 1,
  events: {
    "log.open": { layer: "host", class: "lifecycle", level: "info", fields: { schema: "number", pid: "number", role: "string", boot: "string" } },
    "log.dropped": { layer: "host", class: "lifecycle", level: "warn", fields: { from_seq: "number", to_seq: "number", count: "number" } },
    "native.input.key_down": { layer: "native", class: "input", level: "info", fields: { keyCode: "number" } },
    "page.terminal.send": { layer: "page", class: "input", level: "info", fields: {} },
    "sidecar.vt.pty_write": { layer: "sidecar", class: "io", level: "info", fields: { hex: "string" } },
  },
  chains: { key: ["native.input.key_down", "page.terminal.send", "sidecar.vt.pty_write"] },
};

const line = (seq, event, fields = {}, extra = {}) => JSON.stringify({
  ts_us: 1000 + seq, seq, level: "info", layer: "host", event, fields, ...extra,
});
const open = line(1, "log.open", { schema: 1, pid: 7, role: "host", boot: "b1" });

test("a log with declared events, consecutive seq and a complete chain passes", () => {
  const text = [
    open,
    line(2, "native.input.key_down", { keyCode: 36 }, { cids: ["b1.1"] }),
    line(3, "page.terminal.send", {}, { cids: ["b1.1"], layer: "page" }),
    line(4, "sidecar.vt.pty_write", { hex: "0d" }, { cids: ["b1.1"], layer: "sidecar" }),
  ].join("\n");
  assert.deepEqual(auditLog("host-b1.jsonl", text, catalog), []);
});

test("an undeclared event, a missing field and a field of the wrong type are reported with the line", () => {
  const text = [
    open,
    line(2, "native.input.unknown", {}),
    line(3, "native.input.key_down", {}),
    line(4, "native.input.key_down", { keyCode: "36" }),
  ].join("\n");
  const findings = auditLog("host-b1.jsonl", text, catalog);
  assert.deepEqual(findings.map((f) => f.line), [2, 3, 4]);
  assert.match(findings[0].message, /event native.input.unknown is not declared/);
  assert.match(findings[1].message, /field keyCode is required/);
  assert.match(findings[2].message, /field keyCode must be a number/);
});

test("a gap of seq is a finding unless log.dropped names the range", () => {
  const gap = [open, line(2, "native.input.key_down", { keyCode: 1 }), line(5, "native.input.key_down", { keyCode: 2 })].join("\n");
  assert.match(auditLog("f.jsonl", gap, catalog)[0].message, /seq 5 follows seq 2/);
  const explained = [open, line(2, "native.input.key_down", { keyCode: 1 }),
    line(3, "log.dropped", { from_seq: 4, to_seq: 4, count: 1 }), line(5, "native.input.key_down", { keyCode: 2 })].join("\n");
  assert.deepEqual(auditLog("f.jsonl", explained, catalog), []);
});

test("a declared chain with a missing hop is a finding for its correlation identifier", () => {
  const text = [
    open,
    line(2, "native.input.key_down", { keyCode: 36 }, { cids: ["b1.1"] }),
    line(3, "page.terminal.send", {}, { cids: ["b1.1"], layer: "page" }),
  ].join("\n");
  const findings = auditLog("host-b1.jsonl", text, catalog);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /chain key of b1.1 lacks sidecar.vt.pty_write/);
});

test("a file whose first line is not log.open, or whose schema is unknown, is rejected with the file name and the value", () => {
  assert.throws(() => parseLog("a.jsonl", line(1, "native.input.key_down", { keyCode: 1 })), /a\.jsonl: the first line is not log\.open/);
  const other = line(1, "log.open", { schema: 9, pid: 1, role: "host", boot: "b" });
  assert.throws(() => parseLog("b.jsonl", other), /b\.jsonl: schema 9 is not 1/);
  assert.throws(() => parseLog("c.jsonl", `${open}\n{not json`), /c\.jsonl:2: not JSON/);
});

test("the golden lines and the golden catalog pass the audit", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
  const golden = JSON.parse(read("catalog.json"));
  for (const name of ["key.jsonl", "dropped.jsonl"]) {
    assert.deepEqual(auditLog(name, read(name), golden), [], name);
  }
});

test("a family name with a placeholder declares every event of the family, and a layer outside the catalog is left to its own catalog", () => {
  const family = {
    schema: 1,
    layers: ["host", "page"],
    events: {
      "log.open": catalog.events["log.open"],
      "page.record.<level>": { layer: "page", class: "lifecycle", level: "info", fields: { where: "string", text: "string" } },
      "page.trace.<event>": { layer: "page", class: "call", level: "debug", fields: {} },
    },
  };
  const text = [
    open,
    line(2, "page.record.error", { where: "w", text: "t" }, { layer: "page" }),
    line(3, "page.trace.command", { name: "x" }, { layer: "page" }),
    line(4, "page.trace.sidecar.send", {}, { layer: "page" }),
    line(5, "plugin.terminal.send", { n: 1 }, { layer: "plugin" }),
    line(6, "page.record.error", { where: "w" }, { layer: "page" }),
    line(7, "page.unknown.thing", {}, { layer: "page" }),
  ].join("\n");
  assert.deepEqual(auditLog("host-b1.jsonl", text, family), [
    { line: 6, message: "field text is required by page.record.error" },
    { line: 7, message: "event page.unknown.thing is not declared" },
  ]);
});

test("an optional field is checked only when present, and a type with | accepts each of its parts", () => {
  const optional = {
    schema: 1,
    events: {
      "log.open": catalog.events["log.open"],
      "log.rotated": { layer: "host", class: "lifecycle", level: "info", fields: { bytes: "number", "removed?": "string|null", "note?": "string" } },
    },
  };
  const text = [
    open,
    line(2, "log.rotated", { bytes: 1, removed: null }),
    line(3, "log.rotated", { bytes: 1, removed: "host-1.jsonl.5" }),
    line(4, "log.rotated", { bytes: 1 }),
    line(5, "log.rotated", { bytes: 1, removed: 7 }),
    line(6, "log.rotated", { bytes: 1, note: 3 }),
  ].join("\n");
  assert.deepEqual(auditLog("host-b1.jsonl", text, optional), [
    { line: 5, message: "field removed must be a string|null, found number" },
    { line: 6, message: "field note must be a string, found number" },
  ]);
});
