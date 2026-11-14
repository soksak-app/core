import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { connect } from "@soksak/client";
import { currentEventOffsets, sessionEventBoot } from "@soksak/window-check/event-log.mjs";
import { APPS } from "@soksak/window-check/app.mjs";
import { untilFolderState } from "@soksak/window-check/folder-wait.mjs";
import { untilShutdown } from "@soksak/window-check/shutdown-wait.mjs";
import { prepareRasterSession } from "./raster-probe.mjs";
import { auditShutdownErrors } from "./shutdown-audit.mjs";
import { joinedFailure } from "./fixture.mjs";

// A request and a watch have no time limit: each ends by its answer or notification, or by the close of the connection.
function request(client, method, params) {
  return client.request(method, params);
}

async function untilReady(client) {
  await client.watch("main", "host.windows",
    (windows) => windows.length === 1 && windows[0].ready);
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
  if (services.length !== 1) throw new Error(`${directory} has ${services.length} services with an endpoint, expected the raster probe service`);
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

/**
 * Waits for the end of the service PID through the CLI bundled beside the declared application executable. `sok process wait` has
 * no time limit (docs/spec/cli.md): it answers when the operating system reports the end of the PID, so the wait ends by that end
 * or by the exit of the CLI, and the limit of the test runner bounds a wait that neither ends.
 */
export async function runSokProcessWait({ binary, configDir, pid, ...rest }) {
  if (Object.keys(rest).length > 0) {
    throw new TypeError(`runSokProcessWait takes no ${Object.keys(rest).join(", ")}: the wait ends by the end of the process or of the CLI`);
  }
  const sok = join(dirname(binary), "sok");
  let details;
  try {
    details = statSync(sok);
  } catch (error) {
    throw new Error(`bundled sok executable ${sok} is unavailable: ${error?.message ?? error}`, { cause: error });
  }
  if (!details.isFile() || (details.mode & 0o111) === 0) throw new Error(`bundled sok executable ${sok} is not an executable file`);

  const child = spawn(sok, ["process", "wait", String(pid), "--config-dir", configDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (status.code !== 0) throw new Error(`bundled sok process wait failed for service PID ${pid} with exit ${status.code ?? status.signal}: ${stderr.trim() || stdout.trim() || "no output"}`);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`bundled sok process wait returned invalid JSON for service PID ${pid}: ${error?.message ?? error}; output=${JSON.stringify(stdout)}`, { cause: error });
  }
  if (result.pid !== pid || result.ended !== true) throw new Error(`bundled sok process wait returned ${JSON.stringify(result)} for service PID ${pid}, expected ended=true`);
}

/** Runs the declared shutdown check on the application `app`; `env` holds its variables and `write` receives its report lines. */
export async function runNormalShutdown({
  app = APPS[Object.keys(APPS)[0]],
  env = process.env,
  write = (line) => console.log(line),
} = {}) {
  const endpointFile = `${app.configDir}/endpoint.json`;
  const started = Date.now();
  // Each wait of the check ends by its event and has no time limit: the endpoint file, the end of the connection and the end of
  // the service process; the limit of the test runner bounds the check.
  write(`START normal-shutdown app=${app.name}`);
  await untilFolderState(dirname(endpointFile), () => (existsSync(endpointFile) ? Date.now() - started : undefined));
  const client = await connect({ configDir: app.configDir });
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
    await untilReady(client);
    const raster = env.SOKSAK_SHUTDOWN_SERVICE === "1"
      ? await prepareRasterSession(client, request) : null;
    const by = env.SOKSAK_SHUTDOWN_BY ?? "command";
    if (by !== "command" && by !== "signal") throw new Error(`SOKSAK_SHUTDOWN_BY is ${by}, expected command or signal`);
    service = raster ? serviceEndpoint(app.configDir) : null;
    if (!raster) {
      const objects = await request(client, "diagnostics.objects", { window: "main" });
      if (!objects || !Array.isArray(objects.sessions)) {
        throw new Error("diagnostics.objects returned no sidecar session list for the no-service shutdown precondition");
      }
      const serviceEndpoints = serviceEndpointFiles(app.configDir, { allowMissing: true });
      if (objects.sessions.length !== 0 || serviceEndpoints.length !== 0) {
        throw new Error(`no-service shutdown precondition failed: sidecar sessions=${JSON.stringify(objects.sessions)} service endpoints=${JSON.stringify(serviceEndpoints)}`);
      }
      write(`PRECONDITION normal-shutdown app=${app.name} mode=no-service sidecar_sessions=0 service_endpoints=0`);
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
    const { closedMs } = await untilShutdown(client, endpointFile, { from });
    let serviceObservationMs = "none";
    if (service) {
      const observationFrom = Date.now();
      await runSokProcessWait({ binary: app.binary, configDir: app.configDir, pid: service.pid });
      if (existsSync(service.file)) throw new Error(`${service.file} remains after service PID ${service.pid} ended`);
      serviceObservationMs = Date.now() - observationFrom;
    }
    result = { appName: app.name, pid, raster, closedMs, serviceObservationMs, by };
  } catch (error) {
    failures.push(error);
  }

  // The close of a client records its closing cause and rejects its pending requests; it throws nothing.
  client.close();
  if (audit) {
    try {
      auditShutdownErrors({ appName: app.name, configDir: app.configDir, offsets: audit.offsets, boot: audit.boot });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw joinedFailure(`${app.name}: shutdown reported ${failures.length} errors`, failures);
  }

  write(`PASS normal-shutdown app=${app.name} by=${result.by} pid=${result.pid} raster=${result.raster?.session ?? "none"} endpoint_absent_at_close=true endpoint_closed_ms=${result.closedMs} service_exit_observation_ms=${result.serviceObservationMs}`);
  return { appName: result.appName, pid: result.pid, raster: result.raster, closedMs: result.closedMs, serviceObservationMs: result.serviceObservationMs };
}

