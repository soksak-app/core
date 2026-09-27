// 이미 실행 중인 호스트에서 선언된 command.run -> host.quit 생명주기를 검증한다.
// 이 검사는 애플리케이션을 시작하거나 활성화하지 않는다. 실행 전에
// SOKSAK_APP이 선택한 설정 디렉터리로 호스트를 시작한다.
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import { connect } from "@soksak/client";
import { APPS } from "./app.mjs";

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
  return new Promise((resolve, reject) => {
    let timer;
    let watcher;
    const finish = (error, value) => {
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      if (predicate()) finish(null, Date.now() - started);
    };
    timer = setTimeout(() => {
      watcher?.close();
      reject(new Error(`${label} did not reach the expected state within ${limit}ms`));
    }, limit);
    try {
      watcher = watch(dirname(endpointFile), { persistent: false }, check);
      watcher.once("error", (error) => finish(error));
    } catch (error) {
      finish(error);
      return;
    }
    check();
  });
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

// 프로세스 종료는 설정 디렉터리의 파일 이벤트를 만들지 않는다. 호스트는 종료하기 전에
// endpoint.json 을 지우므로 파일 이벤트만 기다리면 그 뒤의 종료를 확인하지 못한다. Node 는
// 다른 프로세스의 종료 알림(kqueue NOTE_EXIT)을 제공하지 않으므로, 그 알림으로 pid 의 종료를
// 기다리는 macOS 의 `caffeinate -w` 로 기다린다.
function waitForExit(pid) {
  const child = spawn("/usr/bin/caffeinate", ["-w", String(pid)], { stdio: "ignore" });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`caffeinate -w ${pid} ended with ${code ?? signal}`));
    });
  });
  return { exited, cancel: () => child.kill() };
}

function waitForShutdown(pid, limit) {
  const started = Date.now();
  const exit = waitForExit(pid);
  let exitedAt;
  let removedAt;
  let watcher;
  const measured = exit.exited.then(() => {
    exitedAt = Date.now() - started;
  });
  const removed = new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(endpointFile)) return;
      removedAt ??= Date.now() - started;
      watcher?.close();
      resolve();
    };
    try {
      watcher = watch(dirname(endpointFile), { persistent: false }, check);
      watcher.once("error", reject);
    } catch (error) {
      reject(error);
      return;
    }
    check();
  });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`application exit and endpoint removal did not complete within ${limit}ms: ` +
        `process ${exitedAt === undefined ? "running" : `exited at ${exitedAt}ms`}, ` +
        `endpoint.json ${removedAt === undefined ? "present" : `removed at ${removedAt}ms`}`));
    }, limit);
  });
  return Promise.race([Promise.all([measured, removed]), deadline])
    .then(() => ({ exitedAt, removedAt }))
    .finally(() => {
      clearTimeout(timer);
      watcher?.close();
      exit.cancel();
    });
}

console.log(`START normal-shutdown app=${app.name} case_timeout_ms=${SHUTDOWN_LIMIT}`);
await waitForFilesystem("endpoint", () => existsSync(endpointFile), STARTUP_LIMIT);
const client = await connect({ configDir: app.configDir });
const pid = client.endpoint.pid;
await waitForReady(client);
const terminal = process.env.SOKSAK_SHUTDOWN_TERMINAL === "1" ? await prepareTerminal(client) : null;

const started = Date.now();
const result = await request(client, "command.run", {
  window: "main",
  name: "host.quit",
  params: {},
});
if (result !== null) throw new Error(`host.quit returned ${JSON.stringify(result)}, expected null`);
const { exitedAt, removedAt } = await waitForShutdown(pid, SHUTDOWN_LIMIT);
client.close();
console.log(`PASS normal-shutdown app=${app.name} pid=${pid} terminal=${terminal?.sessionId ?? "none"} endpoint_removed_ms=${removedAt} exited_ms=${exitedAt}`);
