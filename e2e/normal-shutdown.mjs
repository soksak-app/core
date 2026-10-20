// Verifies the declared command.run -> host.quit lifecycle on an already running host.
// This check does not start or activate the application. Before the run,
// it starts the host with the configuration directory that SOKSAK_APP selects.
// SOKSAK_SHUTDOWN_BY=signal sends SIGTERM to the host instead, which requests the same quit (docs/spec/hosts.md). With
// SOKSAK_SHUTDOWN_TERMINAL=1 the quit also ends the terminal service, because a normal quit ends the owned sessions and
// shuts the service down (docs/spec/terminal-runtime.md).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect } from "@soksak/client";
import { APPS } from "@soksak/window-check/app.mjs";
import { untilFolderState } from "@soksak/window-check/folder-wait.mjs";
import { untilShutdown } from "@soksak/window-check/shutdown-wait.mjs";

const app = APPS[Object.keys(APPS)[0]];
const endpointFile = `${app.configDir}/endpoint.json`;
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

function waitForFilesystem(label, predicate, limit) {
  const started = Date.now();
  return untilFolderState(dirname(endpointFile), () => (predicate() ? Date.now() - started : undefined), limit,
    () => new Error(`${label} did not reach the expected state within ${limit}ms`));
}

async function waitForReady(client) {
  const started = Date.now();
  await client.watch("main", "host.windows",
    (windows) => windows.length === 1 && windows[0].ready,
    { timeout: STARTUP_LIMIT });
  return Date.now() - started;
}

async function prepareTerminal(client) {
  let surfaces = await request(client, "status.get", { window: "main", name: "core.surfaces" });
  let surface = surfaces.find((item) => item.plugin === "terminal" && item.visible)?.surface;
  if (!surface) {
    await request(client, "diagnostics.fixture", { window: "main", settings: {} });
    const grid = await request(client, "status.get", { window: "main", name: "core.grid" });
    const terminal = grid.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    if (!terminal) throw new Error("shutdown fixture has no terminal tab");
    await request(client, "command.run", { window: "main", name: "core.tab.select", params: { tab: terminal.id } });
  }
  const started = Date.now();
  while (Date.now() - started < STARTUP_LIMIT) {
    surfaces = await request(client, "status.get", { window: "main", name: "core.surfaces" });
    surface = surfaces.find((item) => item.plugin === "terminal" && item.visible)?.surface;
    if (surface) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!surface) throw new Error("shutdown fixture terminal did not become visible");
  await request(client, "command.run", {
    window: "main", name: "terminal.input",
    surface,
    params: { bytes: "printf '\\033[?1002h\\033[?1006hSHUTDOWN-READY\\n'\r" },
  });
  const ready = Date.now();
  while (Date.now() - ready < STARTUP_LIMIT) {
    const session = await request(client, "status.get", { window: "main", name: "terminal.session", surface });
    if (session.sessionId && session.error === undefined) return { surface, sessionId: session.sessionId };
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("terminal session did not become ready before shutdown");
}

/** The configuration directory of the one persistent service that published an endpoint: the terminal service. */
function serviceDirectory() {
  const directory = join(app.configDir, "services");
  const services = readdirSync(directory).filter((name) => existsSync(join(directory, name, "endpoint.json")));
  if (services.length !== 1) throw new Error(`${directory} has ${services.length} services with an endpoint, expected the terminal service`);
  return join(directory, services[0]);
}

console.log(`START normal-shutdown app=${app.name} case_timeout_ms=${SHUTDOWN_LIMIT}`);
await waitForFilesystem("endpoint", () => existsSync(endpointFile), STARTUP_LIMIT);
const client = await connect({ configDir: app.configDir });
const pid = client.endpoint.pid;
await waitForReady(client);
const terminal = process.env.SOKSAK_SHUTDOWN_TERMINAL === "1" ? await prepareTerminal(client) : null;
const by = process.env.SOKSAK_SHUTDOWN_BY ?? "command";
if (by !== "command" && by !== "signal") throw new Error(`SOKSAK_SHUTDOWN_BY is ${by}, expected command or signal`);
// The connections end when their processes end, so each one is opened before the request that ends the application.
const serviceClient = terminal ? await connect({ configDir: serviceDirectory() }) : null;

const from = Date.now();
if (by === "signal") {
  process.kill(pid, "SIGTERM");
} else {
  const result = await request(client, "command.run", {
    window: "main",
    name: "host.quit",
    params: {},
  });
  if (result !== null) throw new Error(`host.quit returned ${JSON.stringify(result)}, expected null`);
}
const { closedMs } = await untilShutdown(client, endpointFile, { from, limit: SHUTDOWN_LIMIT });
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
client.close();
console.log(`PASS normal-shutdown app=${app.name} by=${by} pid=${pid} terminal=${terminal?.sessionId ?? "none"} endpoint_absent_at_close=true endpoint_closed_ms=${closedMs} service_closed_ms=${serviceClosedMs}`);
