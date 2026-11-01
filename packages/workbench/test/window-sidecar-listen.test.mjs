// The main page receives the sidecar messages of a pair only after it registered with the host call sidecarListen, and the last
// listener of the pair removes the registration (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { clockAnswer } from "./support/records.mjs";

const calls = [];
const listeners = new Set();
let releaseListen = null;
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
    if (name === "sidecarListen" && payload.on && releaseListen === null) {
      await new Promise((resolve) => { releaseListen = resolve; });
    }
    return null;
  },
} } });
const { windowSidecar } = await import("../host.js");

const listens = () => calls.filter(([name]) => name === "sidecarListen").map(([, payload]) => payload);
const deliver = (event) => { for (const entry of listeners) if (entry.name === "sidecar-message") entry.fn(event); };

test("the first listener of a pair registers the page, on resolves after the host applied it, and the last listener removes it", { timeout: 5000 }, async () => {
  const sidecar = windowSidecar("@x/side");
  const received = [];
  let resolved = false;
  const first = sidecar.on("tab-a", (body) => received.push(["first", body])).then((off) => { resolved = true; return off; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(listens(), [{ sidecar: "@x/side", id: "tab-a", on: true }], "the first listener registers the page");
  assert.equal(resolved, false, "on resolved before the host applied the registration");
  releaseListen();
  const offFirst = await first;
  const offSecond = await sidecar.on("tab-a", (body) => received.push(["second", body]));
  assert.equal(listens().length, 1, "a second listener of the pair registers nothing");
  deliver({ sidecar: "@x/side", surface: "tab-a", body: { n: 1 } });
  deliver({ sidecar: "@x/side", surface: "tab-b", body: { n: 2 } });
  assert.deepEqual(received, [["first", { n: 1 }], ["second", { n: 1 }]]);
  offFirst();
  assert.equal(listens().length, 1, "the pair keeps its registration while a listener remains");
  offSecond();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(listens().at(-1), { sidecar: "@x/side", id: "tab-a", on: false }, "the last listener removes the registration");
});
