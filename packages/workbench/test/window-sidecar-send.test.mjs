// A failed send to a sidecar from the main page is reported, and the sends after it still reach the host
// (docs/spec/sidecars.md#page-interface).
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf } from "./support/records.mjs";

// The page reads the host when it imports the page modules (the log batcher is created only when a host exists), so a case is
// selected before the import. The import sends no call; each test selects its own case.
selectPageWire("window-sidecar-send-none");
const { windowSidecar } = await import("../host.js");
const { flushEvents } = await import("../page-log.js");

test("a send after a failed send to the same sidecar is delivered and the failure is reported", { timeout: 5000 }, async () => {
  const wire = selectPageWire("window-sidecar-send-failure");
  const sidecar = windowSidecar("@x/side");
  await assert.rejects(sidecar.send("tab-a", { n: 1 }), /gone/);
  await sidecar.send("tab-a", { n: 2 });
  const sends = wire.calls.filter(({ name }) => name === "sidecarSend").map(({ payload }) => payload.body.n);
  assert.deepEqual(sends, [1, 2], "the second send never reached the host");
  await flushEvents();
  const reports = wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload));
  assert.deepEqual(reports, [{ level: "error", where: "sidecar @x/side", text: "send failed: gone" }]);
  wire.finish();
});

test("a window sidecar send passes the correlation identifiers of the input it continues to the host call", { timeout: 5000 }, async () => {
  const wire = selectPageWire("window-sidecar-send-cids");
  const sidecar = windowSidecar("@x/side");
  await sidecar.send("tab-b", { n: 3 }, ["b1.9"]);
  const sent = wire.calls.filter(({ name }) => name === "sidecarSend");
  assert.deepEqual(sent.at(-1).payload, { sidecar: "@x/side", surface: "tab-b", body: { n: 3 }, cids: ["b1.9"] });
  wire.finish();
});
