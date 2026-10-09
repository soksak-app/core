// A failed send to a sidecar from the main page is reported, and the sends after it still reach the host
// (docs/spec/sidecars.md#page-interface).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls = [];
let failFirst = true;
mock.module("@soksak/runtime", { namedExports: { host: {
  on: async () => {},
  page: (path) => path,
  call: async (name, payload) => {
    calls.push([name, payload]);
    if (name === "sidecarSend" && failFirst) {
      failFirst = false;
      throw new Error("gone");
    }
  },
} } });
const { windowSidecar } = await import("../host.js");

test("a send after a failed send to the same sidecar is delivered and the failure is reported", { timeout: 5000 }, async () => {
  const sidecar = windowSidecar("@x/side");
  await assert.rejects(sidecar.send("tab-a", { n: 1 }), /gone/);
  await sidecar.send("tab-a", { n: 2 });
  const sends = calls.filter(([name]) => name === "sidecarSend").map(([, payload]) => payload.body.n);
  assert.deepEqual(sends, [1, 2], "the second send never reached the host");
  const reports = calls.filter(([name]) => name === "report").map(([, record]) => record);
  assert.deepEqual(reports, [{ level: "error", where: "sidecar @x/side", text: "send failed: gone" }]);
});
