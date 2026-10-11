// The records of the page (docs/spec/diagnostics.md#forms, docs/spec/logging.md#writers): a failure and an observation of the
// page are the events `page.record.error` and `page.record.info` with the fields `where` and `text`, queued without waiting
// and relayed to the host in a batch through the call `log`.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { settled } from "./support/records.mjs";

const calls = [];
let failing = null;
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => {
    if (failing) throw failing;
    // The request for the clocks of the host is answered here; the batches are what the tests assert.
    if (name === "log" && payload.action === "clock") return { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
    calls.push({ name, payload });
  },
} } });
const { reportRecord } = await import("../page-log.js");

const events = () => calls.filter(({ name }) => name === "log").flatMap(({ payload }) => payload.events);

test("a failure is the event page.record.error with the place and the text, and the wait ends when it was relayed", async () => {
  calls.length = 0;
  await reportRecord("error", "surface probe mount failed: x");
  assert.equal(calls.some(({ name }) => name === "report"), false, "the host call report is not used any more");
  const [event] = events();
  assert.equal(event.event, "page.record.error");
  assert.equal(event.level, "error");
  assert.deepEqual(event.fields, { where: "surface probe mount failed", text: "x" });
  assert.ok(Number.isInteger(event.ts_us) && event.ts_us > 1.7e15);
});

test("a line without a place has the place page, an observation is the event page.record.info, and the order is kept", async () => {
  calls.length = 0;
  reportRecord("info", "focus moved to probe");
  reportRecord("error", "second: failure\nsecond line");
  await reportRecord("info", "third");
  assert.deepEqual(events().map((event) => [event.event, event.fields.where, event.fields.text]), [
    ["page.record.info", "page", "focus moved to probe"],
    ["page.record.error", "second", "failure\nsecond line"],
    ["page.record.info", "page", "third"],
  ]);
  assert.equal(calls.filter(({ name }) => name === "log").length, 1, "the records of one turn travel in one call");
});

test("a relay that fails is reported on the console with the number of records, and the next record is still relayed", async () => {
  calls.length = 0;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    failing = new Error("host closed");
    await reportRecord("error", "a: lost");
    failing = null;
    await reportRecord("info", "b: kept");
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, ["page event batch of 1 events failed: host closed"]);
  assert.equal(events().at(-1).fields.text, "kept");
});

const { captureConsole, emitEvent } = await import("../page-log.js");

test("emitEvent queues an event of a plugin with its level, name and fields in the batch of the turn", async () => {
  calls.length = 0;
  emitEvent("debug", "plugin.fixture.input", { key: "a", surface: "tab-1" });
  emitEvent("warn", "plugin.fixture.slow", { us: 9 });
  await settled();
  assert.deepEqual(events().map((event) => [event.level, event.event, event.fields]), [
    ["debug", "plugin.fixture.input", { key: "a", surface: "tab-1" }],
    ["warn", "plugin.fixture.slow", { us: 9 }],
  ]);
  assert.equal(calls.filter(({ name }) => name === "log").length, 1);
});

// A console is the output of code that does not use the entrance of the records: console.error is stored at the level warn, so
// it is in the log and does not fail a window check, as it did not before it was recorded. The entrance `log.error` is for errors.
test("captureConsole records what the page writes to its console and keeps the console working", async () => {
  calls.length = 0;
  const written = [];
  const target = { error: (...a) => written.push(["error", a]), warn: (...a) => written.push(["warn", a]),
    info: (...a) => written.push(["info", a]), log: (...a) => written.push(["log", a]), debug: (...a) => written.push(["debug", a]) };
  captureConsole(target);
  captureConsole(target);
  target.error("failed:", { code: 7 }, new Error("boom"));
  target.warn("careful");
  target.info("note", 1);
  target.log("plain");
  target.debug(undefined, null, "d");
  await settled();
  assert.deepEqual(written.map(([kind]) => kind), ["error", "warn", "info", "log", "debug"], "the original methods still ran once each");
  assert.deepEqual(events().map((event) => [event.level, event.event, event.fields.text]), [
    ["warn", "page.console.error", 'failed: {"code":7} Error: boom'],
    ["warn", "page.console.warn", "careful"],
    ["info", "page.console.info", "note 1"],
    ["info", "page.console.log", "plain"],
    ["debug", "page.console.debug", "undefined null d"],
  ]);
});

test("a failed relay is reported on the original console and does not become a console event again", async () => {
  calls.length = 0;
  const reported = [];
  const target = { error: (...a) => reported.push(a.join(" ")), warn() {}, info() {}, log() {}, debug() {} };
  const original = console.error;
  console.error = (...a) => reported.push(a.join(" "));
  try {
    captureConsole(target);
    failing = new Error("host closed");
    emitEvent("info", "plugin.fixture.x", {});
    await settled();
    failing = null;
  } finally {
    console.error = original;
  }
  assert.equal(events().some((event) => event.event === "page.console.error"), false);
  assert.ok(reported.some((line) => line.includes("page event batch of 1 events failed: host closed")));
});

test("every host call is the event page.call with its name, arguments, duration and outcome, except the calls of the log itself and the range reads of the debug timeline", async () => {
  const { settlingCalls } = await import("../host-calls.js");
  calls.length = 0;
  const wrapped = settlingCalls((name) => (name === "bad" ? Promise.reject(new Error("refused")) : Promise.resolve()));
  await wrapped.call("good", { a: 1 });
  await assert.rejects(wrapped.call("bad"), /refused/);
  await wrapped.call("log", { action: "batch", events: [] });
  await wrapped.call("debugReadRange", { path: "logs/host-a.jsonl", offset: 0 });
  await wrapped.call("overlayUpdate", { id: "debug", html: "<p></p>" });
  await wrapped.call("overlayPlace", { id: "debug", rect: { x: 0, y: 0, w: 1, h: 1 } });
  await wrapped.call("big", { text: "x".repeat(5000) });
  await settled();
  const seen = events().filter(({ event }) => event === "page.call");
  assert.deepEqual(seen.map(({ level, fields }) => [level, fields.name, fields.args, fields.ok, fields.error, fields.truncated]), [
    ["debug", "good", '[{"a":1}]', true, undefined, false],
    ["warn", "bad", "[]", false, "-32603: refused", false],
    ["debug", "big", JSON.stringify([{ text: "x".repeat(5000) }]).slice(0, 1024), true, undefined, true],
  ]);
  for (const { fields } of seen) assert.ok(Number.isInteger(fields.micros) && fields.micros >= 0);
});

test("the start of a page is the event page.start with the origin of the document clock and its address", async () => {
  const { recordPageStart } = await import("../page-log.js");
  calls.length = 0;
  recordPageStart({ href: "app://workbench/index.html?window=w1" }, 1791500000000.5);
  await settled();
  assert.deepEqual(events().map((event) => [event.level, event.event, event.fields]), [
    ["info", "page.start", { time_origin: 1791500000000.5, url: "app://workbench/index.html?window=w1" }],
  ]);
});

test("the text of a console call is cut at 8192 bytes while it is serialized, and the event says truncated", async () => {
  calls.length = 0;
  const target = { error() {}, warn() {}, info() {}, log() {}, debug() {} };
  captureConsole(target);
  const reads = { count: 0 };
  const array = new Proxy(new Array(1_000_000).fill(1), {
    get(source, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1;
      return Reflect.get(source, key, receiver);
    },
  });
  target.log("é".repeat(10000));
  target.info(array);
  target.debug("short");
  await settled();
  const [text, structure, short] = events().map((event) => event.fields);
  assert.equal(text.truncated, true);
  assert.ok(Buffer.byteLength(text.text) <= 8192 && Buffer.byteLength(text.text) >= 8190, `${Buffer.byteLength(text.text)} bytes`);
  assert.equal(structure.truncated, true);
  assert.ok(Buffer.byteLength(structure.text) <= 8192, `${Buffer.byteLength(structure.text)} bytes`);
  assert.ok(reads.count < 8192, `${reads.count} elements were read`);
  assert.deepEqual(short, { text: "short" });
});
