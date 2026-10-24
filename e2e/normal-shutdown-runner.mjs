import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect } from "@soksak/client";
import { currentEventOffsets, sessionEventBoot } from "@soksak/window-check/event-log.mjs";
import { APPS } from "@soksak/window-check/app.mjs";
import { untilFolderState } from "@soksak/window-check/folder-wait.mjs";
import { untilShutdown } from "@soksak/window-check/shutdown-wait.mjs";
import { prepareTerminal } from "./prepare-terminal.mjs";
import { auditShutdownErrors } from "./shutdown-audit.mjs";

const STARTUP_LIMIT = 15_000;
const SHUTDOWN_LIMIT = 5_000;
const REQUEST_LIMIT = 10_000;

async function request(client, method, params) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} exceeded ${REQUEST_LIMIT}ms`)), REQUEST_LIMIT);
  });
  try {
    return await Promise.race([client.request(method, params), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(client) {
  await client.watch("main", "host.windows",
    (windows) => windows.length === 1 && windows[0].ready,
    { timeout: STARTUP_LIMIT });
}

function serviceDirectory(configDir) {
  const directory = join(configDir, "services");
  const services = readdirSync(directory).filter((name) => existsSync(join(directory, name, "endpoint.json")));
  if (services.length !== 1) throw new Error(`${directory} has ${services.length} services with an endpoint, expected the terminal service`);
  return join(directory, services[0]);
}

/** Runs the declared shutdown check with replaceable boundaries for its owning controlled-client test. */
export async function runNormalShutdown({
  app = APPS[Object.keys(APPS)[0]],
  connectClient = connect,
  waitForFilesystem,
  waitForReady: waitReady = waitForReady,
  waitForShutdown = untilShutdown,
  prepareTerminal: prepare = prepareTerminal,
  env = process.env,
  write = (line) => console.log(line),
} = {}) {
  const endpointFile = `${app.configDir}/endpoint.json`;
  const started = Date.now();
  const waitFilesystem = waitForFilesystem ?? ((label, predicate, limit) => untilFolderState(dirname(endpointFile),
    () => (predicate() ? Date.now() - started : undefined), limit,
    () => new Error(`${label} did not reach the expected state within ${limit}ms`)));
  write(`START normal-shutdown app=${app.name} case_timeout_ms=${SHUTDOWN_LIMIT}`);
  await waitFilesystem("endpoint", () => existsSync(endpointFile), STARTUP_LIMIT);
  const client = await connectClient({ configDir: app.configDir });
  let serviceClient = null;
  let failure = null;
  let result;
  try {
    const pid = client.endpoint.pid;
    const eventOffsets = currentEventOffsets(app.configDir);
    const eventBoot = sessionEventBoot(app.configDir, pid);
    await waitReady(client);
    const terminal = env.SOKSAK_SHUTDOWN_TERMINAL === "1"
      ? await prepare(client, request, { startupLimit: STARTUP_LIMIT }) : null;
    const by = env.SOKSAK_SHUTDOWN_BY ?? "command";
    if (by !== "command" && by !== "signal") throw new Error(`SOKSAK_SHUTDOWN_BY is ${by}, expected command or signal`);
    serviceClient = terminal ? await connectClient({ configDir: serviceDirectory(app.configDir) }) : null;

    const from = Date.now();
    if (by === "signal") {
      process.kill(pid, "SIGTERM");
    } else {
      const reply = await request(client, "command.run", {
        window: "main",
        name: "host.quit",
        params: {},
      });
      if (reply !== null) throw new Error(`host.quit returned ${JSON.stringify(reply)}, expected null`);
    }
    const { closedMs } = await waitForShutdown(client, endpointFile, { from, limit: SHUTDOWN_LIMIT });
    let serviceClosedMs = "none";
    if (serviceClient) {
      const serviceFrom = Date.now();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the terminal service still holds its connection ${SHUTDOWN_LIMIT}ms after the application quit by ${by}`)), SHUTDOWN_LIMIT);
      });
      try {
        await Promise.race([serviceClient.ended, deadline]);
      } finally {
        clearTimeout(timer);
      }
      serviceClosedMs = Date.now() - serviceFrom;
    }
    result = { appName: app.name, pid, terminal, closedMs, serviceClosedMs, eventOffsets, eventBoot, by };
  } catch (error) {
    failure = error;
  }

  const closeErrors = [];
  for (const [name, connection] of [["terminal-service", serviceClient], ["application", client]]) {
    if (!connection) continue;
    try {
      connection.close();
    } catch (error) {
      closeErrors.push(new Error(`${app.name}: could not close the ${name} client: ${error?.message ?? error}`, { cause: error }));
    }
  }
  if (!failure) {
    try {
      auditShutdownErrors({ appName: app.name, configDir: app.configDir, offsets: result.eventOffsets, boot: result.eventBoot });
    } catch (error) {
      failure = error;
    }
  }
  if (failure && closeErrors.length) {
    throw new AggregateError([failure, ...closeErrors], `${app.name}: shutdown failed: ${failure?.message ?? failure}; client cleanup also reported ${closeErrors.length} error${closeErrors.length === 1 ? "" : "s"}`);
  }
  if (failure) throw failure;
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) throw new AggregateError(closeErrors, `${app.name}: client cleanup reported ${closeErrors.length} errors`);

  write(`PASS normal-shutdown app=${app.name} by=${result.by} pid=${result.pid} terminal=${result.terminal?.sessionId ?? "none"} endpoint_absent_at_close=true endpoint_closed_ms=${result.closedMs} service_closed_ms=${result.serviceClosedMs}`);
  return { appName: result.appName, pid: result.pid, terminal: result.terminal, closedMs: result.closedMs, serviceClosedMs: result.serviceClosedMs };
}

