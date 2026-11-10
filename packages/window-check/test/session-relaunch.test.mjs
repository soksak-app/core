// A relaunch of the host ends when the page of the new process is ready, so the requests of the check and of its cleanups
// that the page answers do not fail with `the main page is not ready` (F192.3-3-1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import test from "node:test";

const watched = [];
const newClient = {
  endpoint: { pid: 200, application: "probe" },
  close() {},
  request: async () => null,
  // The page of the new process becomes ready after the first value of host.windows.
  async watch(window, name, predicate) {
    watched.push({ window, name, before: predicate([{ window: "main", ready: false }]), after: predicate([{ window: "main", ready: true }]) });
    return [{ window: "main", ready: true }];
  },
};
class EndpointError extends Error {}
mock.module("@soksak/client", { namedExports: { connect: async () => newClient, EndpointError } });
let nextEndpoint = async () => ({ pid: 200 });
mock.module("../endpoint-wait.mjs", { namedExports: { untilEndpoint: () => nextEndpoint() } });
const { Session } = await import("../app.mjs");

test("a relaunch waits until every window of the new process reports a ready page", async () => {
  const old = { endpoint: { pid: 100 }, close() {}, request: async () => null };
  const session = new Session({ name: "probe", configDir: "/nonexistent" }, old);
  await session.relaunch();
  assert.equal(session.client, newClient);
  assert.deepEqual(watched, [{ window: "main", name: "host.windows", before: false, after: true }]);
});

test("a relaunch whose process exited and that no process replaced fails with the exit, and the later checks do not run", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-relaunch-exit-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  mkdirSync(join(configDir, "logs"));
  writeFileSync(join(configDir, "logs", `host-1794212313-${pid}.jsonl`), [
    { seq: 5404, level: "info", event: "log.closed", fields: { cause: "update" } },
    { seq: 5417, level: "error", event: "host.record.error", fields: { text: "the main webview is not in the window hierarchy", where: "main webview identity" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  nextEndpoint = async () => { throw new SyntaxError("endpoint.json is not JSON: Unexpected end of JSON input"); };
  t.after(() => { nextEndpoint = async () => ({ pid: 200 }); });
  const session = new Session({ name: "probe", configDir }, { endpoint: { pid }, close() {}, request: async () => null });
  session.check = "full screen";
  await assert.rejects(session.relaunch(), (error) => {
    assert.match(error.message, new RegExp(`^probe process ${pid} exited in the check "full screen" and no process took its place \\(endpoint\\.json is not JSON: Unexpected end of JSON input\\)`));
    assert.match(error.message, /seq 5404 log\.closed cause update; seq 5417 host\.record\.error the main webview is not in the window hierarchy \(main webview identity\)/);
    return true;
  });
  const record = JSON.parse(readFileSync(join(configDir, "exited.json"), "utf8"));
  assert.deepEqual([record.check, record.pid], ["full screen", pid]);
});
