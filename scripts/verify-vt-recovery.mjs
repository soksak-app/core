import { mkdir, readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const STEP_TIMEOUT_MS = 5000;

const fail = (message) => {
  throw new Error(message);
};

const withTimeout = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const waitForFile = async (path) => {
  const started = performance.now();
  while (performance.now() - started < STEP_TIMEOUT_MS) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  fail(`endpoint file ${path} timed out after ${STEP_TIMEOUT_MS}ms`);
};

const lineClient = async (endpoint, clientName) => {
  const socket = net.createConnection(endpoint.socket);
  await withTimeout(new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  }), "socket connect");
  socket.setEncoding("utf8");

  let buffered = "";
  const queued = [];
  const waiters = [];
  let socketError;
  socket.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else queued.push(value);
    }
  });
  socket.on("error", (error) => {
    socketError = error;
    while (waiters.length) waiters.shift().reject(error);
  });
  socket.on("close", () => {
    const error = socketError ?? new Error("sidecar socket closed");
    while (waiters.length) waiters.shift().reject(error);
  });

  const next = () => {
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const write = (value) => socket.write(`${JSON.stringify(value)}\n`);
  write({ op: "hello", protocol: 1, token: endpoint.token, client: clientName });
  const hello = await withTimeout(next(), "hello response");
  if (hello.op !== "hello" || hello.ok !== true || hello.protocol !== 1) {
    fail(`invalid hello response: ${JSON.stringify(hello)}`);
  }
  return { socket, next, write };
};

const screenText = (value) => (value.body?.lines ?? [])
  .map((row) => row.map((cell) => cell.ch).join(""))
  .join("\n");

const waitFor = async (client, predicate, label) => {
  const started = performance.now();
  while (performance.now() - started < STEP_TIMEOUT_MS) {
    const value = await withTimeout(client.next(), label);
    if (predicate(value)) return value;
  }
  fail(`${label} timed out after ${STEP_TIMEOUT_MS}ms`);
};

const sendSurface = (client, surface, root, body) => {
  client.write({ surface, root, body });
};

const assertServiceAlive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    fail(`service ${pid} is not alive after client disconnect: ${error.message}`);
  }
};

const main = async () => {
  const binary = process.argv[2];
  if (!binary || process.argv.length !== 3) {
    fail("usage: node scripts/verify-vt-recovery.mjs <sidecar-binary>");
  }

  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), "soksak-vt-recovery-"));
  const serviceDirectory = join(root, "services", "vt-alacritty");
  await mkdir(serviceDirectory, { recursive: true, mode: 0o700 });
  const service = spawn(binary, ["--service-dir", serviceDirectory], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serviceStderr = "";
  service.stderr.setEncoding("utf8");
  service.stderr.on("data", (chunk) => { serviceStderr += chunk; });

  const endpointPath = join(serviceDirectory, "endpoint.json");
  let first;
  let second;
  try {
    const endpoint = JSON.parse(await waitForFile(endpointPath));
    if (endpoint.protocol !== 1 || !endpoint.socket || !endpoint.token || endpoint.pid !== service.pid) {
      fail(`invalid endpoint: ${JSON.stringify(endpoint)}`);
    }
    const surface = "recovery-surface";
    const project = "/recovery/project";
    const clientName = serviceDirectory;
    first = await lineClient(endpoint, clientName);
    sendSurface(first, surface, project, { op: "open", image: "terminal" });
    sendSurface(first, surface, project, { image: { configure: {
      name: "terminal", generation: 1, raster: 1, width: 640, height: 384, scale: 1,
    } } });
    const state = await waitFor(first, (value) => value.surface === surface && value.body?.event === "state", "initial state");
    const sessionId = state.body.sessionId;
    if (!sessionId) fail("initial state did not contain a session ID");
    sendSurface(first, surface, project, {
      op: "input",
      bytes: Buffer.from("echo RECOVERY\n").toString("base64"),
    });
    await waitFor(first, (value) => value.surface === surface && value.body?.event === "screen" && screenText(value).includes("RECOVERY"), "initial output");
    first.socket.destroy();
    await withTimeout(new Promise((resolve) => first.socket.once("close", resolve)), "first socket close");
    assertServiceAlive(service.pid);
    console.log(`PASS service_alive_after_client_loss pid=${service.pid}`);

    second = await lineClient(endpoint, clientName);
    sendSurface(second, surface, project, { op: "open", image: "terminal" });
    sendSurface(second, surface, project, { op: "screen.read" });
    const reconnected = await waitFor(second, (value) => value.surface === surface && value.body?.event === "session", "session reattach");
    if (reconnected.body.sessionId !== sessionId) {
      fail(`session changed from ${sessionId} to ${reconnected.body.sessionId}`);
    }
    await waitFor(second, (value) => value.surface === surface && value.body?.event === "screen" && screenText(value).includes("RECOVERY"), "retained output");
    console.log(`PASS session_id_preserved session=${sessionId}`);
    console.log("PASS retained_screen_contains_RECOVERY");
    sendSurface(second, surface, project, { op: "close" });
  } catch (error) {
    const detail = serviceStderr.trim();
    throw new Error(detail ? `${error.message}; service stderr: ${detail}` : error.message);
  } finally {
    first?.socket.destroy();
    second?.socket.destroy();
    if (!service.killed) service.kill("SIGTERM");
    await withTimeout(new Promise((resolve) => {
      if (service.exitCode !== null) resolve();
      else service.once("exit", resolve);
    }), "service cleanup");
    await rm(root, { recursive: true, force: false });
  }
  console.log(`PASS recovery_check_duration_ms=${Math.round(performance.now() - started)}`);
};

try {
  await main();
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
