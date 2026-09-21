// 이미 실행 중인 호스트에서 선언된 command.run -> host.quit 생명주기를 검증한다.
// 이 검사는 애플리케이션을 시작하거나 활성화하지 않는다. 실행 전에
// SOKSAK_APP이 선택한 설정 디렉터리로 호스트를 시작한다.
import { existsSync } from "node:fs";
import { connect } from "@soksak/client";
import { APPS } from "./app.mjs";

const app = APPS[Object.keys(APPS)[0]];
const endpointFile = `${app.configDir}/endpoint.json`;
const STARTUP_LIMIT = 15_000;
const SHUTDOWN_LIMIT = 5_000;
const REQUEST_LIMIT = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

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

async function waitFor(label, predicate, limit) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (predicate()) return Date.now() - started;
    await sleep(100);
  }
  throw new Error(`${label} did not reach the expected state within ${limit}ms`);
}

async function waitForReady(client) {
  const started = Date.now();
  while (Date.now() - started < STARTUP_LIMIT) {
    const windows = await request(client, "status.get", { window: "main", name: "host.windows" });
    if (windows.length === 1 && windows[0].ready) return Date.now() - started;
    await sleep(100);
  }
  throw new Error(`ready window did not reach the expected state within ${STARTUP_LIMIT}ms`);
}

console.log(`START normal-shutdown app=${app.name} case_timeout_ms=${SHUTDOWN_LIMIT}`);
await waitFor("endpoint", () => existsSync(endpointFile), STARTUP_LIMIT);
const client = await connect({ configDir: app.configDir });
const pid = client.endpoint.pid;
await waitForReady(client);

const started = Date.now();
const result = await request(client, "command.run", {
  window: "main",
  name: "host.quit",
  params: {},
});
if (result !== null) throw new Error(`host.quit returned ${JSON.stringify(result)}, expected null`);
client.close();
const elapsed = await waitFor("application exit and endpoint removal", () =>
  !processAlive(pid) && !existsSync(endpointFile), SHUTDOWN_LIMIT);
console.log(`PASS normal-shutdown app=${app.name} pid=${pid} elapsed_ms=${elapsed}`);
