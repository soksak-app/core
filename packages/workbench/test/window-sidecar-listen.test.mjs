// The main page receives the sidecar messages of a pair only after it registered with the host call sidecarListen, and the last
// listener of the pair removes the registration (docs/spec/native-surfaces.md#view-surfaces). The host calls are answered by the
// page-wire cases of docs/spec/cases/page-wire.
import assert from "node:assert/strict";
import test from "node:test";
import { selectPageWire } from "@soksak/runtime";

// Each test selects its own case before the host module is used. The first case is selected before the import, because the page reads the host
// when it is imported.
let wire = selectPageWire("window-sidecar-listen-register");
const { windowSidecar } = await import("../host.js");

// The page starts the sidecarListen call after one turn of its queue, so a turn of the event loop lets the call reach the host.
const turn = () => new Promise((resolve) => setImmediate(resolve));
const listens = () => wire.calls.filter(({ name }) => name === "sidecarListen").map(({ payload }) => payload);

test("the first listener of a pair registers the page, on resolves after the host applied it, and the last listener removes it", { timeout: 5000 }, async () => {
  wire = selectPageWire("window-sidecar-listen-register");
  const sidecar = windowSidecar("@x/side");
  // The order of the test's release of the host registration and of the resolution of on.
  const order = [];
  const received = [];
  const first = sidecar.on("tab-a", (body) => received.push(["first", body])).then((off) => { order.push("resolved"); return off; });
  await turn();
  assert.deepEqual(listens(), [{ sidecar: "@x/side", id: "tab-a", on: true }], "the first listener registers the page");
  order.push("applied");
  // The host applies the registration when the test releases its held reply.
  wire.release();
  const offFirst = await first;
  assert.deepEqual(order, ["applied", "resolved"], "on resolved before the host applied the registration");
  const offSecond = await sidecar.on("tab-a", (body) => received.push(["second", body]));
  assert.equal(listens().length, 1, "a second listener of the pair registers nothing");
  wire.deliverNotice();
  wire.deliverNotice();
  assert.deepEqual(received, [["first", { n: 1 }], ["second", { n: 1 }]]);
  offFirst();
  // The removal of the last listener is the next sidecarListen call. The list shows that no call removed the pair after offFirst.
  assert.equal(listens().length, 1, "the pair keeps its registration while a listener remains");
  offSecond();
  // The removal is sent after the calls before it, so a turn of the event loop lets the call reach the host.
  await turn();
  assert.deepEqual(listens(), [{ sidecar: "@x/side", id: "tab-a", on: true }, { sidecar: "@x/side", id: "tab-a", on: false }],
    "the pair keeps its registration while a listener remains, and the last listener removes the registration");
  wire.finish();
});

test("a registration that the host refuses rejects the listener, which resolves only after the host answered", { timeout: 5000 }, async () => {
  wire = selectPageWire("window-sidecar-listen-refused");
  const sidecar = windowSidecar("@x/refused");
  const refused = sidecar.on("tab-refused", () => {});
  await turn();
  // The host answers with the refusal: on must reject with it. A resolved on would show that it did not wait for the host answer.
  wire.release();
  await assert.rejects(refused, /sidecar listen refused/, "on resolved although the host refused the registration");
  wire.finish();
});

test("a listener receives the identifiers of the requests that a message answers", { timeout: 10000 }, async () => {
  wire = selectPageWire("window-sidecar-listen-cids");
  const sidecar = windowSidecar("@x/cids");
  const received = [];
  const off = await sidecar.on("tab-cids", (body, cids) => received.push([body, cids]));
  wire.deliverNotice();
  wire.deliverNotice();
  assert.deepEqual(received, [[{ ack: true }, ["b1.7"]], [{ event: "state" }, []]]);
  off();
  await turn();
  wire.finish();
});
