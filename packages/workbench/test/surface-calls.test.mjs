// The host calls of a surface document (docs/spec/logging.md#automatic-entrances): every call is the event `page.call`, the
// events of one turn travel in one `log` request, and the records of the document keep their order among the calls.
import assert from "node:assert/strict";
import test from "node:test";
import { surfaceCalls } from "../surface-calls.js";

function setup(send) {
  const requests = [];
  const calls = surfaceCalls({ send, log: async (request) => {
    if (request.action === "clock") return { ts_us: 1_791_000_000_000_456, mono_ns: 5_000_000_789 };
    requests.push(request);
  } });
  return { calls, requests, events: () => requests.flatMap((request) => request.events) };
}

test("a call returns its answer and is recorded after it ended, with the duration and the outcome", async () => {
  const { calls, events } = setup(async (name, value) => ({ echoed: value }));
  assert.deepEqual(await calls.call("documentAttach", { document: "d" }), { echoed: { document: "d" } });
  await calls.record("info", "page.record.info", { where: "page", text: "after" });
  assert.deepEqual(events().map((event) => [event.event, event.level]), [["page.call", "debug"], ["page.record.info", "info"]]);
  const { fields } = events()[0];
  assert.equal(fields.name, "documentAttach");
  assert.equal(fields.args, '[{"document":"d"}]');
  assert.equal(fields.ok, true);
  assert.ok(Number.isInteger(fields.micros) && fields.micros >= 0);
});

test("a rejected call and a call that throws before sending are warn events, and the caller gets the same error", async () => {
  const failure = new Error("refused by the host");
  const { calls, events } = setup((name) => {
    if (name === "throws") throw failure;
    return Promise.reject(failure);
  });
  await assert.rejects(calls.call("rejects"), (error) => error === failure);
  await assert.rejects(calls.call("throws"), (error) => error === failure);
  await calls.record("info", "page.record.info", {});
  assert.deepEqual(events().slice(0, 2).map((event) => [event.level, event.fields.name, event.fields.ok, event.fields.error]), [
    ["warn", "rejects", false, "refused by the host"],
    ["warn", "throws", false, "refused by the host"],
  ]);
});
