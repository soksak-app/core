import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
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
const SERVICE_WAIT_LIMIT = 5_000;
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

function serviceEndpointFiles(configDir, { allowMissing = false } = {}) {
  const directory = join(configDir, "services");
  let root;
  try {
    root = lstatSync(directory);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return [];
    throw error;
  }
  if (root.isSymbolicLink()) throw new Error(`${directory} is a symbolic link`);
  if (!root.isDirectory()) throw new Error(`${directory} is not a directory`);

  const services = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const service = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${service} is a symbolic link`);
    if (!entry.isDirectory()) throw new Error(`${service} is not a service directory`);
    const endpoint = join(service, "endpoint.json");
    let metadata;
    try {
      metadata = lstatSync(endpoint);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`${endpoint} could not be inspected: ${error?.message ?? error}`, { cause: error });
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${endpoint} is not a regular file`);
    services.push(endpoint);
  }
  return services;
}

function serviceDirectory(configDir) {
  const directory = join(configDir, "services");
  const services = serviceEndpointFiles(configDir).map((endpoint) => dirname(endpoint));
  if (services.length !== 1) throw new Error(`${directory} has ${services.length} services with an endpoint, expected the terminal service`);
  return services[0];
}

function serviceEndpoint(configDir) {
  const directory = serviceDirectory(configDir);
  const file = join(directory, "endpoint.json");
  let endpoint;
  try {
    endpoint = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid service endpoint JSON: ${error?.message ?? error}`, { cause: error });
  }
  if (!endpoint || endpoint.protocol !== 1 || !Number.isInteger(endpoint.pid) || endpoint.pid < 1 || endpoint.pid > 2_147_483_647) {
    throw new Error(`${file} must contain protocol 1 and a positive int32 pid`);
  }
  return { file, pid: endpoint.pid };
}

/** Waits for the service PID through the CLI bundled beside the declared application executable. */
export async function runSokProcessWait({ binary, configDir, pid, timeoutMs = SERVICE_WAIT_LIMIT, outerLimitMs = timeoutMs + 2_000, cleanupLimitMs = 1_000, spawnChild = spawn }) {
  const sok = join(dirname(binary), "sok");
  let details;
  try {
    details = statSync(sok);
  } catch (error) {
    throw new Error(`bundled sok executable ${sok} is unavailable: ${error?.message ?? error}`, { cause: error });
  }
  if (!details.isFile() || (details.mode & 0o111) === 0) throw new Error(`bundled sok executable ${sok} is not an executable file`);

  const child = spawnChild(sok, ["process", "wait", String(pid), "--timeout-ms", String(timeoutMs), "--config-dir", configDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timer;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      reject(new Error(`bundled sok process wait exceeded ${outerLimitMs}ms for service PID ${pid}`));
    }, outerLimitMs);
  });
  let status;
  try {
    status = await Promise.race([closed, deadline]);
  } catch (error) {
    if (timedOut) {
      let cleanupTimeout;
      let cleanupTimer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          cleanupTimer = setTimeout(() => {
            cleanupTimeout = new Error(`observer cleanup wait exceeded ${cleanupLimitMs}ms after SIGTERM`);
            reject(cleanupTimeout);
          }, cleanupLimitMs);
        })]);
      } catch (cleanupError) {
        if (cleanupError === cleanupTimeout) {
          try {
            child.kill("SIGKILL");
            await closed;
          } catch (reapError) {
            throw new AggregateError([error, cleanupError, reapError], `${error.message}; ${cleanupError.message}; observer SIGKILL/reap failed: ${reapError?.message ?? reapError}`);
          }
          throw new AggregateError([error, cleanupError], `${error.message}; ${cleanupError.message}; SIGKILL sent and observer child reaped`);
        }
        throw new AggregateError([error, cleanupError], `${error.message}; observer cleanup failed: ${cleanupError?.message ?? cleanupError}`);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (status.code !== 0) throw new Error(`bundled sok process wait failed for service PID ${pid} with exit ${status.code ?? status.signal}: ${stderr.trim() || stdout.trim() || "no output"}`);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`bundled sok process wait returned invalid JSON for service PID ${pid}: ${error?.message ?? error}; output=${JSON.stringify(stdout)}`, { cause: error });
  }
  if (result.pid !== pid || result.ended !== true) throw new Error(`bundled sok process wait returned ${JSON.stringify(result)} for service PID ${pid}, expected ended=true`);
}

/** Runs the declared shutdown check with replaceable boundaries for its owning controlled-client test. */
export async function runNormalShutdown({
  app = APPS[Object.keys(APPS)[0]],
  connectClient = connect,
  waitForFilesystem,
  waitForReady: waitReady = waitForReady,
  waitForShutdown = untilShutdown,
  waitForServiceProcess: waitServiceProcess = runSokProcessWait,
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
  let service = null;
  const failures = [];
  let audit = null;
  let result;
  try {
    const pid = client.endpoint.pid;
    audit = {
      offsets: currentEventOffsets(app.configDir),
      boot: sessionEventBoot(app.configDir, pid),
    };
    await waitReady(client);
    const terminal = env.SOKSAK_SHUTDOWN_TERMINAL === "1"
      ? await prepare(client, request, { startupLimit: STARTUP_LIMIT }) : null;
    const by = env.SOKSAK_SHUTDOWN_BY ?? "command";
    if (by !== "command" && by !== "signal") throw new Error(`SOKSAK_SHUTDOWN_BY is ${by}, expected command or signal`);
    service = terminal ? serviceEndpoint(app.configDir) : null;
    if (!terminal) {
      const objects = await request(client, "diagnostics.objects", { window: "main" });
      if (!objects || !Array.isArray(objects.sessions)) {
        throw new Error("diagnostics.objects returned no sidecar session list for the no-terminal shutdown precondition");
      }
      const serviceEndpoints = serviceEndpointFiles(app.configDir, { allowMissing: true });
      if (objects.sessions.length !== 0 || serviceEndpoints.length !== 0) {
        throw new Error(`no-terminal shutdown precondition failed: sidecar sessions=${JSON.stringify(objects.sessions)} service endpoints=${JSON.stringify(serviceEndpoints)}`);
      }
      write(`PRECONDITION normal-shutdown app=${app.name} mode=no-terminal sidecar_sessions=0 service_endpoints=0`);
    }

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
    let serviceObservationMs = "none";
    if (service) {
      const observationFrom = Date.now();
      await waitServiceProcess({ binary: app.binary, configDir: app.configDir, pid: service.pid, timeoutMs: SERVICE_WAIT_LIMIT });
      if (existsSync(service.file)) throw new Error(`${service.file} remains after service PID ${service.pid} ended`);
      serviceObservationMs = Date.now() - observationFrom;
    }
    result = { appName: app.name, pid, terminal, closedMs, serviceObservationMs, by };
  } catch (error) {
    failures.push(error);
  }

  const closeErrors = [];
  for (const [name, connection] of [["application", client]]) {
    if (!connection) continue;
    try {
      connection.close();
    } catch (error) {
      closeErrors.push(new Error(`${app.name}: could not close the ${name} client: ${error?.message ?? error}`, { cause: error }));
    }
  }
  if (audit) {
    try {
      auditShutdownErrors({ appName: app.name, configDir: app.configDir, offsets: audit.offsets, boot: audit.boot });
    } catch (error) {
      failures.push(error);
    }
  }
  failures.push(...closeErrors);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${app.name}: shutdown reported ${failures.length} errors; primary failure: ${failures[0]?.message ?? String(failures[0])}`);
  }

  write(`PASS normal-shutdown app=${app.name} by=${result.by} pid=${result.pid} terminal=${result.terminal?.sessionId ?? "none"} endpoint_absent_at_close=true endpoint_closed_ms=${result.closedMs} service_exit_observation_ms=${result.serviceObservationMs}`);
  return { appName: result.appName, pid: result.pid, terminal: result.terminal, closedMs: result.closedMs, serviceObservationMs: result.serviceObservationMs };
}

