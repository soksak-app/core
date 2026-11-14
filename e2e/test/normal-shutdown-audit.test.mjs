import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCasePlayer } from "@soksak/client/testing";

import { runNormalShutdown, runSokProcessWait } from "../normal-shutdown-runner.mjs";

// The bundled sok executable of the tests is a real program in the folder of the host binary: the echo of the system, which prints its
// arguments and so answers no JSON, and the fixture program of the CLI, which answers once the process of the PID is gone.
const SOK_FIXTURE = fileURLToPath(new URL("../fixtures/programs/sok-process-wait.mjs", import.meta.url));

/** A configuration folder whose host folder holds the bundled sok executable `install(path)` puts in place. */
function bundledSok(install) {
  const configDir = mkdtempSync(join(tmpdir(), "normal-shutdown-sok-"));
  const appDirectory = join(configDir, "MacOS");
  mkdirSync(appDirectory, { recursive: true });
  install(join(appDirectory, "sok"));
  return { configDir, binary: join(appDirectory, "Host") };
}

const errorLine = (seq, where, text) => `${JSON.stringify({ seq, level: "error", layer: "host", event: "host.record.error", fields: { where, text } })}\n`;

/**
 * The application of the endpoint case `name` for the shutdown check: the player of the case is the endpoint of the host whose process is
 * the process of the test, its configuration folder holds the event log of that host, and the host folder of `app.binary` holds the
 * bundled sok executable of the fixture program. The player removes endpoint.json when it receives host.quit, as the host does before its process ends, and
 * `onQuit` runs at the same request. Closing the player fails when the case was not played.
 */
async function startApp(t, name, { onQuit, removeEndpoint = true } = {}) {
  const server = await startCasePlayer(name);
  t.after(() => server.close());
  const logs = join(server.configDir, "logs");
  mkdirSync(logs);
  const log = join(logs, `host-100-${process.pid}.jsonl`);
  writeFileSync(log, `${JSON.stringify({ seq: 1, level: "info", layer: "host", event: "log.open", fields: {} })}\n`);
  const sok = bundledSok((path) => copyFileSync(SOK_FIXTURE, path));
  t.after(() => rmSync(sok.configDir, { recursive: true, force: true }));
  server.events.on("request", ({ method, params }) => {
    if (method !== "command.run" || params.name !== "host.quit") return;
    if (removeEndpoint) rmSync(join(server.configDir, "endpoint.json"));
    onQuit?.({ log, configDir: server.configDir });
  });
  return { server, log, app: { name: "wailsv3", configDir: server.configDir, binary: sok.binary } };
}

/** Writes the endpoint file of a persistent service of the raster probe in its folder of the configuration folder. */
function serviceEndpoint(configDir, content) {
  const directory = join(configDir, "services", "rasterprobe");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "endpoint.json");
  writeFileSync(file, `${JSON.stringify(content)}\n`);
  return file;
}

const QUIET = () => {};

test("no-service shutdown refuses a sidecar session before requesting quit", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-session-live");
  await assert.rejects(runNormalShutdown({ app, env: {}, write: QUIET }), /no-service shutdown precondition failed: sidecar sessions=/);
});

test("no-service shutdown refuses a persistent service endpoint without a session", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-objects-empty");
  const endpointFile = serviceEndpoint(app.configDir, { protocol: 1, pid: 321, socket: "unused", token: "unused" });
  await assert.rejects(runNormalShutdown({ app, env: {}, write: QUIET }), (error) => {
    assert.match(error.message, /no-service shutdown precondition failed/);
    assert.ok(error.message.includes(endpointFile), `the error does not name ${endpointFile}: ${error.message}`);
    return true;
  });
});

test("no-service shutdown records the empty session and endpoint precondition", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-quit");
  const lines = [];
  await runNormalShutdown({ app, env: {}, write: (line) => lines.push(line) });
  assert.ok(lines.includes("PRECONDITION normal-shutdown app=wailsv3 mode=no-service sidecar_sessions=0 service_endpoints=0"),
    `the empty no-service precondition was not recorded: ${JSON.stringify(lines)}`);
});

test("no-service shutdown reports invalid diagnostic session metadata", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-objects-invalid");
  await assert.rejects(runNormalShutdown({ app, env: {}, write: QUIET }), /diagnostics\.objects returned no sidecar session list/);
});

test("no-service shutdown reports a non-directory service entry", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-objects-empty");
  const serviceEntry = join(app.configDir, "services", "invalid-entry");
  mkdirSync(join(app.configDir, "services"));
  writeFileSync(serviceEntry, "invalid\n");
  await assert.rejects(runNormalShutdown({ app, env: {}, write: QUIET }), (error) => {
    assert.equal(error.message, `${serviceEntry} is not a service directory`);
    return true;
  });
});

test("normal shutdown rejects an application error written by the controlled host during quit", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-quit", { onQuit: ({ log }) => appendFileSync(log, errorLine(2, "shutdown", "quit failed")) });
  await assert.rejects(runNormalShutdown({ app, env: {}, write: QUIET }),
    /wailsv3: the application logged 1 error during shutdown:\nerror host shutdown: quit failed/);
});

test("normal shutdown ignores an application error written before the audit offset", { timeout: 20000 }, async (t) => {
  const { app, log } = await startApp(t, "normal-shutdown-quit");
  appendFileSync(log, errorLine(2, "earlier", "old failure"));
  const result = await runNormalShutdown({ app, env: {}, write: QUIET });
  assert.equal(result.appName, "wailsv3");
  assert.equal(result.pid, process.pid);
});

test("normal shutdown retains an application error when the shutdown wait fails", { timeout: 20000 }, async (t) => {
  // The host keeps endpoint.json after it ends the connection, so the wait for the shutdown fails.
  const { app } = await startApp(t, "normal-shutdown-quit", {
    removeEndpoint: false,
    onQuit: ({ log }) => appendFileSync(log, errorLine(2, "shutdown", "late quit failure")),
  });
  await assert.rejects(runNormalShutdown({ app, env: {}, write: QUIET }), (error) => {
    assert.ok(error instanceof AggregateError, `expected both failures, received ${error}`);
    assert.match(error.errors[0].message, /endpoint\.json exists \d+ms after the request; the host removes it before its process ends/);
    assert.match(error.errors[1].message, /application logged 1 error during shutdown/);
    assert.match(error.errors[1].message, /error host shutdown: late quit failure/);
    return true;
  });
});

test("normal shutdown fails when the host keeps its endpoint file after the end of the connection of a service shutdown", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-service-quit", { removeEndpoint: false });
  serviceEndpoint(app.configDir, { protocol: 1, pid: 321, socket: "unused", token: "unused" });
  await assert.rejects(runNormalShutdown({ app, env: { SOKSAK_SHUTDOWN_SERVICE: "1" }, write: QUIET }),
    /endpoint\.json exists \d+ms after the request/);
});

test("service shutdown fails when the service process still runs after the end of the connection", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-service-quit");
  // The service process is the process of this test, which runs: the CLI refuses and the refusal is the error of the wait.
  serviceEndpoint(app.configDir, { protocol: 1, pid: process.pid, socket: "unused", token: "unused" });
  await assert.rejects(runNormalShutdown({ app, env: { SOKSAK_SHUTDOWN_SERVICE: "1" }, write: QUIET }),
    /process wait failed for service PID \d+ with exit 1: process \d+ still runs/);
});

test("service shutdown rejects a service endpoint that remains after PID observation", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-service-quit");
  // The service process is a real process that ended: its PID is gone, which the CLI reports as the end.
  const service = spawnSync("true");
  serviceEndpoint(app.configDir, { protocol: 1, pid: service.pid, socket: "unused", token: "unused" });
  await assert.rejects(runNormalShutdown({ app, env: { SOKSAK_SHUTDOWN_SERVICE: "1" }, write: QUIET }),
    new RegExp(`services/rasterprobe/endpoint.json remains after service PID ${service.pid} ended`));
});

test("service shutdown names an invalid service endpoint, rejects its PID and closes the connection", { timeout: 20000 }, async (t) => {
  const { app } = await startApp(t, "normal-shutdown-service-prepared");
  const file = serviceEndpoint(app.configDir, { protocol: 2, pid: -1 });
  await assert.rejects(runNormalShutdown({ app, env: { SOKSAK_SHUTDOWN_SERVICE: "1" }, write: QUIET }),
    (error) => error.message === `${file} must contain protocol 1 and a positive int32 pid`);
});

test("service process wait takes no limit", async () => {
  await assert.rejects(runSokProcessWait({ binary: "/nonexistent/Host", configDir: "/nonexistent", pid: 321, timeoutMs: 700 }),
    /^TypeError: runSokProcessWait takes no timeoutMs: the wait ends by the end of the process or of the CLI$/);
});

test("service process wait rejects malformed CLI output", { timeout: 10000 }, async () => {
  const { configDir, binary } = bundledSok((sok) => symlinkSync("/bin/echo", sok));
  try {
    await assert.rejects(runSokProcessWait({ binary, configDir, pid: 321 }), /returned invalid JSON for service PID 321/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("service process wait invokes the bundled CLI with the original PID", { timeout: 10000 }, async () => {
  const { configDir, binary } = bundledSok((sok) => copyFileSync(SOK_FIXTURE, sok));
  // The service process of the wait is a real process that ended: its PID is gone, which the CLI reports as the end.
  const service = spawnSync("true");
  try {
    await runSokProcessWait({ binary, configDir, pid: service.pid });
    // A process that still runs is not ended: the CLI refuses, and the refusal is the error of the wait.
    await assert.rejects(runSokProcessWait({ binary, configDir, pid: process.pid }), /process wait failed for service PID \d+ with exit 1: process \d+ still runs/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
