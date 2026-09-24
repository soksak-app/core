import { mkdir, readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { loadavg, tmpdir } from "node:os";
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

const waitForFile = async (path, service) => {
  const started = performance.now();
  while (performance.now() - started < STEP_TIMEOUT_MS) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  // 실패를 해석하도록 서비스가 살아 있는지와 부하를 적는다. 서비스 stderr 는 호출자가 붙인다.
  fail(`endpoint file ${path} timed out after ${STEP_TIMEOUT_MS}ms (service pid ${service.pid}, ` +
    `exit ${service.exitCode ?? "none"}, signal ${service.signalCode ?? "none"}, ` +
    `load average ${loadavg().map((value) => value.toFixed(1)).join(" ")})`);
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
  write({ operation: "hello", protocol: 1, token: endpoint.token, client: clientName });
  const hello = await withTimeout(next(), "hello response");
  if (hello.operation !== "hello" || hello.ok !== true || hello.protocol !== 1) {
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
    fail(`service ${pid} is not alive after application process exit: ${error.message}`);
  }
};

const closeSocket = async (socket, label) => {
  socket.destroy();
  await withTimeout(new Promise((resolve) => socket.once("close", resolve)), label);
};

const worker = async () => {
  if (process.argv.length !== 7) {
    fail("usage: node scripts/verify-vt-recovery.mjs --worker <endpoint> <service-dir> <initial|restore> [session]");
  }
  const endpointPath = process.argv[3];
  const serviceDirectory = process.argv[4];
  const mode = process.argv[5];
  const expectedSession = process.argv[6];
  if (mode !== "initial" && mode !== "restore") fail(`unknown worker mode: ${mode}`);
  if (mode === "restore" && !expectedSession) fail("restore worker requires a session ID");

  const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
  const surface = "recovery-surface";
  const project = "/recovery/project";
  const client = await lineClient(endpoint, serviceDirectory);
  try {
    sendSurface(client, surface, project, { operation: "open", image: "terminal" });
    if (mode === "initial") {
      sendSurface(client, surface, project, { image: { configure: {
        name: "terminal", generation: 1, raster: 1, width: 640, height: 384, scale: 1,
      } } });
      const state = await waitFor(client, (value) => value.surface === surface && value.body?.event === "state", "worker initial state");
      const sessionId = state.body.sessionId;
      if (!sessionId) fail("worker initial state did not contain a session ID");
      sendSurface(client, surface, project, {
        operation: "input",
        bytes: Buffer.from("echo RECOVERY\n").toString("base64"),
      });
      await waitFor(client, (value) => value.surface === surface && value.body?.event === "screen" && screenText(value).includes("RECOVERY"), "worker initial output");
      console.log(`WORKER_SESSION_ID=${sessionId}`);
      return;
    }

    sendSurface(client, surface, project, { operation: "screen.read" });
    const reconnected = await waitFor(client, (value) => value.surface === surface && value.body?.event === "session", "worker session reattach");
    if (reconnected.body.sessionId !== expectedSession) {
      fail(`worker session changed from ${expectedSession} to ${reconnected.body.sessionId}`);
    }
    await waitFor(client, (value) => value.surface === surface && value.body?.event === "screen" && screenText(value).includes("RECOVERY"), "worker retained output");
    console.log(`WORKER_RESTORED_SESSION_ID=${expectedSession}`);
    sendSurface(client, surface, project, { operation: "close" });
  } finally {
    await closeSocket(client.socket, `worker ${mode} socket close`);
  }
};

const runWorker = async (endpointPath, serviceDirectory, mode, sessionId = "-") => {
  const child = spawn(process.execPath, [process.argv[1], "--worker", endpointPath, serviceDirectory, mode, sessionId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await withTimeout(new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }), `worker ${mode} process`);
  if (result.code !== 0) {
    fail(`worker ${mode} exited with code=${result.code} signal=${result.signal}: ${stderr.trim()}`);
  }
  return stdout;
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
  try {
    const endpoint = JSON.parse(await waitForFile(endpointPath, service));
    console.log(`PASS service_endpoint_ms=${Math.round(performance.now() - started)}`);
    if (endpoint.protocol !== 1 || !endpoint.socket || !endpoint.token || endpoint.pid !== service.pid) {
      fail(`invalid endpoint: ${JSON.stringify(endpoint)}`);
    }
    const initial = await runWorker(endpointPath, serviceDirectory, "initial");
    const sessionMatch = initial.match(/^WORKER_SESSION_ID=([^\n]+)$/m);
    if (!sessionMatch) fail(`initial worker did not report a session ID: ${initial.trim()}`);
    const sessionId = sessionMatch[1];
    assertServiceAlive(service.pid);
    console.log(`PASS service_alive_after_application_process_exit pid=${service.pid}`);
    const restored = await runWorker(endpointPath, serviceDirectory, "restore", sessionId);
    if (!restored.match(new RegExp(`^WORKER_RESTORED_SESSION_ID=${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"))) {
      fail(`restore worker did not report the expected session: ${restored.trim()}`);
    }
    console.log(`PASS application_process_restarted session=${sessionId}`);
    console.log("PASS retained_screen_contains_RECOVERY");
  } catch (error) {
    const detail = serviceStderr.trim();
    throw new Error(detail ? `${error.message}; service stderr: ${detail}` : error.message);
  } finally {
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
  if (process.argv[2] === "--worker") await worker();
  else await main();
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
