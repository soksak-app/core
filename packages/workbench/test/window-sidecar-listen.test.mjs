// The main page receives the sidecar messages of a pair only after it registered with the host call sidecarListen, and the last
// listener of the pair removes the registration (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { clockAnswer } from "./support/records.mjs";

const calls = [];
const listeners = new Set();
let releaseListen = null;
// Set by a test before its registration: the next registration then waits for the release of the test.
let holdNextListen = false;
// The resolver of the next sidecarListen call that the host receives.
let listenArrived = null;
const nextListen = () => new Promise((resolve) => { listenArrived = resolve; });
mock.module("@soksak/runtime", { namedExports: { host: {
  on: async (name, fn) => {
    const entry = { name, fn };
    listeners.add(entry);
    return () => listeners.delete(entry);
  },
  page: (path) => path,
  call: async (name, payload) => {
    if (clockAnswer(name, payload)) return clockAnswer(name, payload);
    calls.push([name, payload]);
    if (name === "sidecarListen") {
      const arrived = listenArrived;
      listenArrived = null;
      arrived?.();
    }
    if (name === "sidecarListen" && payload.on && holdNextListen) {
      holdNextListen = false;
      // The host answers the registration when the test releases it: with no error, or with the refusal the test gives.
      await new Promise((resolve, reject) => { releaseListen = (error) => { if (error) reject(error); else resolve(); }; });
    }
    return null;
  },
} } });
const { windowSidecar } = await import("../host.js");

const listens = () => calls.filter(([name]) => name === "sidecarListen").map(([, payload]) => payload);
const deliver = (event) => { for (const entry of listeners) if (entry.name === "sidecar-message") entry.fn(event); };

test("the first listener of a pair registers the page, on resolves after the host applied it, and the last listener removes it", { timeout: 5000 }, async () => {
  const sidecar = windowSidecar("@x/side");
  holdNextListen = true;
  const received = [];
  // The order of the test's release of the host registration and of the resolution of on.
  const order = [];
  const listening = nextListen();
  const first = sidecar.on("tab-a", (body) => received.push(["first", body])).then((off) => { order.push("resolved"); return off; });
  await listening;
  assert.deepEqual(listens(), [{ sidecar: "@x/side", id: "tab-a", on: true }], "the first listener registers the page");
  order.push("applied");
  releaseListen();
  const offFirst = await first;
  assert.deepEqual(order, ["applied", "resolved"], "on resolved before the host applied the registration");
  const offSecond = await sidecar.on("tab-a", (body) => received.push(["second", body]));
  assert.equal(listens().length, 1, "a second listener of the pair registers nothing");
  deliver({ sidecar: "@x/side", surface: "tab-a", body: { n: 1 } });
  deliver({ sidecar: "@x/side", surface: "tab-b", body: { n: 2 } });
  assert.deepEqual(received, [["first", { n: 1 }], ["second", { n: 1 }]]);
  offFirst();
  // The removal of the last listener is the next sidecarListen call. The list shows that no call removed the pair after offFirst.
  const unlistening = nextListen();
  offSecond();
  await unlistening;
  assert.deepEqual(listens(), [{ sidecar: "@x/side", id: "tab-a", on: true }, { sidecar: "@x/side", id: "tab-a", on: false }],
    "the pair keeps its registration while a listener remains, and the last listener removes the registration");
});

test("a registration that the host refuses rejects the listener, which resolves only after the host answered", { timeout: 5000 }, async () => {
  const sidecar = windowSidecar("@x/refused");
  holdNextListen = true;
  const listening = nextListen();
  const refused = sidecar.on("tab-refused", () => {});
  await listening;
  // The host answers with the refusal: on must reject with it. A resolved on would show that it did not wait for the host answer.
  releaseListen(new Error("sidecar listen refused"));
  await assert.rejects(refused, /sidecar listen refused/, "on resolved although the host refused the registration");
});

test("a listener receives the identifiers of the requests that a message answers", { timeout: 10000 }, async () => {
  const sidecar = windowSidecar("@x/cids");
  const received = [];
  const off = await sidecar.on("tab-cids", (body, cids) => received.push([body, cids]));
  deliver({ sidecar: "@x/cids", surface: "tab-cids", cids: ["b1.7"], body: { ack: true } });
  deliver({ sidecar: "@x/cids", surface: "tab-cids", body: { event: "state" } });
  assert.deepEqual(received, [[{ ack: true }, ["b1.7"]], [{ event: "state" }, []]]);
  await off();
});
