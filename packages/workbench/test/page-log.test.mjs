// The records of the page (docs/spec/diagnostics.md#forms, docs/spec/logging.md#writers): a failure and an observation of the
// page are the events `page.record.error` and `page.record.info` with the fields `where` and `text`, queued without waiting
// and relayed to the host in a batch through the call `log`.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls = [];
let failing = null;
mock.module("@soksak/runtime", { namedExports: { host: {
  on: () => {},
  page: (path) => path,
  call: async (name, payload) => {
    calls.push({ name, payload });
    if (failing) throw failing;
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
