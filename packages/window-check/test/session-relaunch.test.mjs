// A relaunch of the host ends when the page of the new process is ready, so the requests of the check and of its cleanups
// that the page answers do not fail with `the main page is not ready` (F192.3-3-1).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";

import { Session } from "../app.mjs";

const idleProcess = fileURLToPath(new URL("../fixtures/idle-process.mjs", import.meta.url));

/** The session of the application whose host is the case player of `name` with the process `pid`; its connection ends with the test. */
async function runningSession(t, name, pid) {
  const server = await startCasePlayer(name, { pid });
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { server, session: new Session({ name: "probe", configDir: server.configDir }, client) };
}

/** Replaces endpoint.json of the folder as the host does, through a temporary file that it renames. */
function writeEndpoint(configDir, text) {
  const temporary = join(configDir, "endpoint.json.tmp");
  writeFileSync(temporary, text);
  renameSync(temporary, join(configDir, "endpoint.json"));
}

test("a relaunch waits until every window of the new process reports a ready page", async (t) => {
  const { server, session } = await runningSession(t, "window-check-relaunch-request", process.pid);
  // The new process is another case player, which listens on its own address and names a process other than the old one.
  const replacement = await startCasePlayer("window-check-relaunch-ready", { pid: process.ppid });
  t.after(() => replacement.close());
  const requested = server.nextRequest("diagnostics.host.relaunch");
  // The unwatch that follows the ready page is the last frame of the case; the close of the client drops it unless it was received.
  const unwatched = replacement.nextRequest("status.unwatch");
  const relaunch = session.relaunch();
  await requested;
  writeEndpoint(server.configDir, readFileSync(join(replacement.configDir, "endpoint.json"), "utf8"));
  await relaunch;
  await unwatched;
  assert.equal(session.client.endpoint.pid, process.ppid);
  assert.equal(session.client.endpoint.address, JSON.parse(readFileSync(join(replacement.configDir, "endpoint.json"), "utf8")).address);
  t.after(() => session.client.close());
});

test("a relaunch whose process exited and that no process replaced fails with the exit, and the later checks do not run", async (t) => {
  // The host runs while the session connects to it and exits before the relaunch ends.
  const host = spawn(process.execPath, [idleProcess], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => host.kill("SIGKILL"));
  await once(host.stdout, "data");
  const { pid } = host;
  const { server, session } = await runningSession(t, "window-check-relaunch-request", pid);
  const configDir = server.configDir;
  mkdirSync(join(configDir, "logs"));
  writeFileSync(join(configDir, "logs", `host-1794212313-${pid}.jsonl`), [
    { seq: 5404, level: "info", event: "log.closed", fields: { cause: "update" } },
    { seq: 5417, level: "error", event: "host.record.error", fields: { text: "the main webview is not in the window hierarchy", where: "main webview identity" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  session.check = "full screen";
  const requested = server.nextRequest("diagnostics.host.relaunch");
  const relaunch = session.relaunch();
  host.kill("SIGKILL");
  await once(host, "exit");
  const rejected = assert.rejects(relaunch, (error) => {
    assert.match(error.message, new RegExp(`^probe process ${pid} exited in the check "full screen" and no process took its place \\(.*endpoint\\.json is not JSON: Unexpected end of JSON input\\)`));
    assert.match(error.message, /seq 5404 log\.closed cause update; seq 5417 host\.record\.error the main webview is not in the window hierarchy \(main webview identity\)/);
    return true;
  });
  await requested;
  // The host that exited left an endpoint.json that is not complete.
  writeEndpoint(configDir, "");
  await rejected;
  const record = JSON.parse(readFileSync(join(configDir, "exited.json"), "utf8"));
  assert.deepEqual([record.check, record.pid], ["full screen", pid]);
});
