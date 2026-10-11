// The audit of the logs that tests leave (docs/spec/logging.md#checking).
import assert from "node:assert/strict";
import test from "node:test";

import { auditLog, auditLogs, composeCatalogs, parseLog } from "../index.js";

const catalog = {
  schema: 2,
  events: {
    "log.open": { layer: "host", class: "lifecycle", level: "info", fields: { schema: "number", pid: "number", role: "string", boot: "string" } },
    "log.dropped": { layer: "host", class: "lifecycle", level: "warn", fields: { from_seq: "number", to_seq: "number", count: "number" } },
    "native.input.key_down": { layer: "native", class: "input", level: "info", fields: { keyCode: "number" } },
    "native.input.text": { layer: "native", class: "input", level: "info", cids: "required", fields: { keyCode: "number" } },
    "page.terminal.send": { layer: "page", class: "input", level: "info", fields: {} },
    "sidecar.vt.pty_write": { layer: "sidecar", class: "io", level: "info", fields: { hex: "string" } },
  },
  chains: { key: ["native.input.key_down", "page.terminal.send", "sidecar.vt.pty_write"] },
};

const line = (seq, event, fields = {}, extra = {}) => JSON.stringify({
  ts_us: 1000 + seq, mono_ns: 5_000_000 + seq, seq, level: "info", layer: "host", event, fields, ...extra,
});
const open = line(1, "log.open", { schema: 2, pid: 7, role: "host", boot: "b1" });

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

test("an event that the writer stored cut holds its head and the size before the cut, and the audit does not ask for the declared fields", () => {
  const cut = (seq, extra, fields = { head: '{"keyCode":' }) => line(seq, "native.input.key_down", fields, extra);
  assert.deepEqual(auditLog("host-b1.jsonl", [open, cut(2, { truncated: 2097152 })].join("\n"), catalog), []);
  const findings = auditLog("host-b1.jsonl", [
    open,
    cut(2, { truncated: 0 }),
    cut(3, { truncated: "big" }),
    cut(4, { truncated: 2097152 }, {}),
    cut(5, { truncated: 2097152 }, { head: 7 }),
  ].join("\n"), catalog);
  assert.deepEqual(findings.map((f) => f.line), [2, 3, 4, 5]);
  assert.match(findings[0].message, /truncated must be a positive integer/);
  assert.match(findings[1].message, /truncated must be a positive integer/);
  assert.match(findings[2].message, /fields of a truncated event must hold the string head/);
  assert.match(findings[3].message, /fields of a truncated event must hold the string head/);
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
  assert.throws(() => parseLog("b.jsonl", other), /b\.jsonl: schema 9 is not 2/);
  assert.throws(() => parseLog("c.jsonl", `${open}\n{not json`), /c\.jsonl:2: not JSON/);
  // A file of the earlier schema is rejected: it has no mono_ns and the reader keeps no code for it.
  const earlier = line(1, "log.open", { schema: 1, pid: 1, role: "host", boot: "b" });
  assert.throws(() => parseLog("d.jsonl", earlier), /d\.jsonl: schema 1 is not 2/);
});

test("a line without mono_ns, or with a mono_ns that is not a positive integer, is a finding", () => {
  const withMono = (seq, mono) => JSON.stringify({ ts_us: 1000 + seq, ...(mono === undefined ? {} : { mono_ns: mono }), seq, level: "info", layer: "host", event: "log.dropped", fields: { from_seq: 1, to_seq: 1, count: 1 } });
  const findings = auditLog("host-b1.jsonl", [open, withMono(2), withMono(3, "1"), withMono(4, 1.5), withMono(5, 0), withMono(6, 7)].join("\n"), catalog);
  assert.deepEqual(findings.map((f) => f.line), [2, 3, 4, 5]);
  for (const finding of findings) assert.match(finding.message, /mono_ns must be a positive integer/);
});

test("an event that the catalog declares with cids required is a finding without cids, with an empty list, or with a value that is not a string", () => {
  const text = [
    open,
    line(2, "native.input.text", { keyCode: 1 }),
    line(3, "native.input.text", { keyCode: 1 }, { cids: [] }),
    line(4, "native.input.text", { keyCode: 1 }, { cids: [7] }),
    line(5, "native.input.text", { keyCode: 1 }, { cids: ["b1.1"] }),
  ].join("\n");
  const findings = auditLog("host-b1.jsonl", text, catalog);
  assert.deepEqual(findings.filter((f) => /requires cids/.test(f.message)).map((f) => f.line), [2, 3, 4]);
  assert.match(findings.find((f) => f.line === 2).message, /event native\.input\.text requires cids/);
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
    schema: 2,
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
    schema: 2,
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

const lines = (...items) => `${items.join("\n")}\n`;
const generation = (first, last, boot = "b1") => lines(
  line(first, "log.open", { schema: 2, pid: 7, role: "host", boot }),
  ...Array.from({ length: last - first }, (_, index) => line(first + 1 + index, "native.input.key_down", { keyCode: 1 })),
);

test("seq continues across the rotated generations of one process, and a missing generation is a finding", () => {
  const whole = [{ file: "host-1-2.jsonl.1", text: generation(1, 3) }, { file: "host-1-2.jsonl", text: generation(4, 6) }];
  assert.deepEqual(auditLogs(whole, catalog), []);
  const lost = [{ file: "host-1-2.jsonl.2", text: generation(1, 3) }, { file: "host-1-2.jsonl", text: generation(7, 9) }];
  assert.deepEqual(auditLogs(lost, catalog), [{ file: "host-1-2.jsonl", line: 1, message: "seq 7 follows seq 3" }]);
});

test("seq continues across the main file and the debug file of one process", () => {
  const main = lines(open, line(2, "native.input.key_down", { keyCode: 1 }), line(4, "native.input.key_down", { keyCode: 3 }));
  const debug = lines(line(3, "log.open", { schema: 2, pid: 7, role: "host", boot: "b1" }), line(5, "native.input.key_down", { keyCode: 4 }));
  assert.deepEqual(auditLogs([{ file: "host-1-2.jsonl", text: main }, { file: "host-1-2.debug.jsonl", text: debug }], catalog), []);
  const short = lines(line(3, "log.open", { schema: 2, pid: 7, role: "host", boot: "b1" }), line(6, "native.input.key_down", { keyCode: 4 }));
  assert.deepEqual(auditLogs([{ file: "host-1-2.jsonl", text: main }, { file: "host-1-2.debug.jsonl", text: short }], catalog), [
    { file: "host-1-2.debug.jsonl", line: 2, message: "seq 6 follows seq 4" },
  ]);
});

test("the files of different processes have separate seq, and a file name outside the pattern is an error", () => {
  const host = { file: "host-1-2.jsonl", text: generation(1, 3) };
  const sidecar = { file: "vt-3-4.jsonl", text: generation(1, 2, "b2") };
  assert.deepEqual(auditLogs([host, sidecar], catalog), []);
  assert.throws(() => auditLogs([{ file: "other.log", text: generation(1, 2) }], catalog), /other\.log: not an event file name/);
});

test("an error event is a finding with its file and line unless the caller declares it", () => {
  const errorLine = (seq) => line(seq, "native.input.key_down", { keyCode: 1 }, { level: "error" });
  const text = lines(open, errorLine(2), errorLine(3));
  const logs = [{ file: "host-1-2.jsonl", text }];
  assert.deepEqual(auditLogs(logs, catalog), [
    { file: "host-1-2.jsonl", line: 2, message: "undeclared error native.input.key_down: {\"keyCode\":1}" },
    { file: "host-1-2.jsonl", line: 3, message: "undeclared error native.input.key_down: {\"keyCode\":1}" },
  ]);
  assert.deepEqual(auditLogs(logs, catalog, (file, entry) => entry.line === 2).map((f) => f.line), [3]);
});

test("the chains of the files of one configuration folder join, so a hop in a sidecar file completes a chain of the host file", () => {
  const host = lines(open,
    line(2, "native.input.key_down", { keyCode: 36 }, { cids: ["b1.1"] }),
    line(3, "page.terminal.send", {}, { cids: ["b1.1"], layer: "page" }));
  const sidecar = lines(line(1, "log.open", { schema: 2, pid: 8, role: "vt", boot: "b2" }),
    line(2, "sidecar.vt.pty_write", { hex: "0d" }, { cids: ["b1.1"], layer: "sidecar" }));
  assert.deepEqual(auditLogs([{ file: "host-1-2.jsonl", text: host }, { file: "vt-3-4.jsonl", text: sidecar }], catalog), []);
  assert.deepEqual(auditLogs([{ file: "host-1-2.jsonl", text: host }], catalog), [
    { file: "host-1-2.jsonl", line: 2, message: "chain key of b1.1 lacks sidecar.vt.pty_write" },
  ]);
});

test("an entrance of calls that the catalog declares with a result has ok, micros and an error of the form <code>: <text> only when ok is false", () => {
  const withResult = {
    ...catalog,
    events: {
      ...catalog.events,
      "host.binding.call": {
        layer: "host", class: "call", level: ["debug", "warn"], result: true,
        fields: { name: "string", ok: "boolean", micros: "number", "error?": "string" },
      },
    },
  };
  const call = (seq, fields) => line(seq, "host.binding.call", { name: "windowNew", micros: 12, ...fields });
  assert.deepEqual(auditLog("host-b1.jsonl", [
    open,
    call(2, { ok: true }),
    call(3, { ok: false, error: "-32603: the request is refused" }),
    call(4, { ok: false, error: "-32602: bad: params" }),
  ].join("\n"), withResult), []);
  const findings = auditLog("host-b1.jsonl", [
    open,
    call(2, { ok: true, error: "-32603: x" }),
    call(3, { ok: false }),
    call(4, { ok: false, error: "the request is refused" }),
    call(5, { ok: false, error: ": no code" }),
    call(6, { ok: true, micros: -1 }),
    call(7, { ok: true, micros: 1.5 }),
  ].join("\n"), withResult);
  assert.deepEqual(findings.map((f) => f.line), [2, 3, 4, 5, 6, 7]);
  assert.match(findings[0].message, /ok is true, so error must be absent/);
  assert.match(findings[1].message, /ok is false, so error is required/);
  assert.match(findings[2].message, /error must be <code>: <text>/);
  assert.match(findings[3].message, /error must be <code>: <text>/);
  assert.match(findings[4].message, /micros must be a non-negative integer/);
  assert.match(findings[5].message, /micros must be a non-negative integer/);
});

test("the chain of an operation of the page is complete when its call and the host record carry its identifiers, in any file", () => {
  const operations = {
    ...catalog,
    events: {
      ...catalog.events,
      "page.plugin.operation": { layer: "page", class: "call", level: "info", cids: "required", fields: { action: "string", plugin: "string" } },
      "page.call": { layer: "page", class: "call", level: ["debug", "warn"], fields: { name: "string" } },
      "host.binding.call": { layer: "host", class: "call", level: ["debug", "warn"], fields: { name: "string" } },
    },
    chains: { plugin: ["page.plugin.operation", "page.call", "host.binding.call"] },
  };
  const start = (seq, cid) => line(seq, "page.plugin.operation", { action: "install", plugin: "term" }, { cids: [cid], layer: "page" });
  const call = (seq, cid) => line(seq, "page.call", { name: "pluginsRun" }, { cids: [cid], layer: "page", level: "debug" });
  const binding = (seq, cid) => line(seq, "host.binding.call", { name: "plugins_run" }, { cids: [cid], level: "debug" });
  const complete = [open, start(2, "p1.1"), call(3, "p1.1"), binding(4, "p1.1")].join("\n");
  assert.deepEqual(auditLog("host-b1.jsonl", complete, operations), []);
  // The host record is missing for the second operation, and the first one in the other file completes by the host file.
  const findings = auditLogs([
    { file: "host-b1.jsonl", text: [open, binding(2, "p1.1")].join("\n") },
    { file: "host-b1.debug.jsonl", text: [line(3, "log.open", { schema: 2, pid: 7, role: "host", boot: "b1" }), start(4, "p1.1"), call(5, "p1.1"), start(6, "p1.2"), call(7, "p1.2")].join("\n") },
  ], operations);
  assert.deepEqual(findings.map(({ message }) => message), ["chain plugin of p1.2 lacks host.binding.call"]);
});

// The chain extension of a sidecar catalog and the lifecycle events of the layer sidecar (docs/spec/logging.md#sidecar-catalogs).
const extensionFixture = async (name) => {
  const { readFileSync } = await import("node:fs");
  return readFileSync(new URL(`../fixtures/extension/${name}`, import.meta.url), "utf8");
};
const extensionCatalog = async () => composeCatalogs(JSON.parse(await extensionFixture("base.json")), JSON.parse(await extensionFixture("alpha.json")));
const extensionLogs = async (...names) => Promise.all(names.map(async (file) => ({ file, text: await extensionFixture(file) })));

test("a chain extension of a sidecar catalog is complete when its events follow the request that names the sidecar, in any file", async () => {
  const catalog = await extensionCatalog();
  assert.deepEqual(auditLogs(await extensionLogs("host-1-2.jsonl", "alpha-3-4.jsonl"), catalog), []);
});

test("a chain extension reports the sidecar event that a request naming the sidecar lacks, with the file and line of the request", async () => {
  const catalog = await extensionCatalog();
  assert.deepEqual(auditLogs(await extensionLogs("host-1-2.jsonl", "alpha-idle-3-4.jsonl"), catalog), [
    { file: "host-1-2.jsonl", line: 3, message: "chain input of b1.1 lacks sidecar.alpha.write after host.sidecar.request of alpha" },
  ]);
});

test("a chain extension does not flag the cids of a request that names another sidecar", async () => {
  const catalog = await extensionCatalog();
  assert.deepEqual(auditLogs(await extensionLogs("host-other-1-2.jsonl", "alpha-idle-3-4.jsonl"), catalog), []);
});

test("an extension that names an unknown chain, an event outside the chain or an undeclared event is an error, not a finding", async () => {
  const base = JSON.parse(await extensionFixture("base.json"));
  const alpha = JSON.parse(await extensionFixture("alpha.json"));
  const withExtension = (extension) => composeCatalogs(base, { ...alpha, extends: [extension] });
  const good = alpha.extends[0];
  assert.throws(() => withExtension({ ...good, chain: "output" }), /sidecar alpha: the extension names the chain output, which the catalog does not declare/);
  assert.throws(() => withExtension({ ...good, after: "page.call" }), /sidecar alpha: the extension follows page\.call, which is not an event of the chain input/);
  assert.throws(() => withExtension({ ...good, after: "native.input.key_down" }), /sidecar alpha: the extension follows native\.input\.key_down, which has no field name/);
  assert.throws(() => withExtension({ ...good, events: ["sidecar.alpha.read"] }), /sidecar alpha: the extension names sidecar\.alpha\.read, which the catalog does not declare/);
  assert.throws(() => withExtension({ ...good, events: [] }), /sidecar alpha: the extension of the chain input lists no events/);
});

test("the lifecycle events of the layer sidecar that a sidecar catalog declares pass, and a field the catalog requires is a finding", async () => {
  const catalog = await extensionCatalog();
  assert.deepEqual(auditLogs(await extensionLogs("alpha-3-4.jsonl"), catalog), []);
  const text = (await extensionFixture("alpha-3-4.jsonl")).replace(',"reason":"disk full"', "");
  assert.deepEqual(auditLogs([{ file: "alpha-3-4.jsonl", text }], catalog), [
    { file: "alpha-3-4.jsonl", line: 5, message: "field reason is required by log.dropped" },
  ]);
  const undeclared = (await extensionFixture("alpha-3-4.jsonl")).replaceAll("sidecar.alpha.start", "sidecar.alpha.begin");
  assert.deepEqual(auditLogs([{ file: "alpha-3-4.jsonl", text: undeclared }], catalog).map(({ message }) => message), [
    "event sidecar.alpha.begin is not declared", "event sidecar.alpha.begin is not declared",
  ]);
});

test("a sidecar catalog is refused when it names no sidecar, owns another layer, declares a foreign event or contradicts a shared lifecycle event", async () => {
  const base = JSON.parse(await extensionFixture("base.json"));
  const alpha = JSON.parse(await extensionFixture("alpha.json"));
  const compose = (change) => composeCatalogs(base, { ...alpha, ...change });
  assert.throws(() => compose({ sidecar: undefined }), /sidecar catalog: the member sidecar must name the sidecar/);
  assert.throws(() => compose({ layers: ["sidecar", "host"] }), /sidecar alpha: layers must be \["sidecar"\]/);
  assert.throws(() => compose({ events: { ...alpha.events, "sidecar.beta.write": alpha.events["sidecar.alpha.write"] } }), /sidecar alpha: event sidecar\.beta\.write does not start with sidecar\.alpha\./);
  assert.throws(() => compose({ events: { ...alpha.events, "host.sidecar.request": { ...alpha.events["sidecar.alpha.write"], layer: "host" } } }), /sidecar alpha: event host\.sidecar\.request has the layer host, not sidecar/);
  assert.throws(() => compose({ events: { ...alpha.events, "log.rotated": { ...alpha.events["log.rotated"], fields: { bytes: "number" } } } }), /sidecar alpha: event log\.rotated differs from the declaration of the base catalog/);
});
