// V5-113: 충돌로 고아가 된 WebKit XPC 를 앱 재시작이 증명 기반으로 수확하는지 잰다.
// 케이스 행렬 — 단순 껐다켰다가 아니라 부분 킬·외인성 상태를 포함한다:
//   1) 호스트 생존 중 자식 하나를 외부 킬 → 교체 스폰 → 기록이 갱신되어야 한다.
//   2) 호스트 사망 + 자식 일부 사전 킬(혼합) → 살아 있는 기록만 수확, 죽은 기록은 건너뛴다.
//   3) 미기록 외부 WebKit 흉내는 어떤 경로에서도 불가침이다.
//   4) 기록된 WebKit 이름의 희생제는 수확 경로의 결정적 증명이다.
// 이 검사는 앱을 직접 띄우고 죽인다. 분리된 임시 설정 디렉터리만 쓴다.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@soksak/client";

const BINARIES = {
  tauriv2: fileURLToPath(new URL("../target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2", import.meta.url)),
  wailsv3: fileURLToPath(new URL("../target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3", import.meta.url)),
};
const selected = process.env.SOKSAK_APP ? [process.env.SOKSAK_APP] : Object.keys(BINARIES);
const STARTUP_LIMIT = 20_000;
const WAIT_LIMIT = 15_000;

function webkitProcesses() {
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const found = new Map();
  for (const line of out.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const kind = match[2].match(/com\.apple\.WebKit\.(WebContent|GPU|Networking)/);
    if (kind) found.set(Number(match[1]), kind[1]);
  }
  return found;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitUntil(predicate, what, limit = WAIT_LIMIT) {
  const started = Date.now();
  while (Date.now() - started < limit) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`${what} did not happen within ${limit}ms`);
}

async function startApp(binary, configDir) {
  rmSync(join(configDir, "endpoint.json"), { force: true });
  const child = spawn(binary, ["--config-dir", configDir], { stdio: ["ignore", "pipe", "pipe"] });
  child.log = "";
  child.stdout.on("data", (chunk) => { child.log += chunk; });
  child.stderr.on("data", (chunk) => { child.log += chunk; });
  const endpoint = join(configDir, "endpoint.json");
  await waitUntil(() => existsSync(endpoint) && alive(JSON.parse(readFileSync(endpoint, "utf8")).pid),
    "the application did not publish a live endpoint", STARTUP_LIMIT);
  const client = await connect({ configDir });
  await client.watch("main", "host.windows", (windows) => windows.length === 1 && windows[0].ready,
    { timeout: STARTUP_LIMIT });
  return { child, client };
}

const recordsFile = (configDir) => join(configDir, "webkit-children.json");
const readRecords = (configDir) => {
  const file = recordsFile(configDir);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} webkit-reaping ${what}`);
  if (!ok) failures++;
};

async function runCaseMatrix(appName, binary) {
  const failuresBefore = failures;
const configDir = mkdtempSync(join(tmpdir(), "soksak-reaping-"));

// 외부 더미: 다른 번들의 저장소 파일을 연 채 사는 미기록 WebKit 흉내(불가침 증명).
const foreignStore = join(configDir, "foreign-store", "com.example.foreigner", "WebsiteData", "ResourceLoadStatistics", "observations.db");
mkdirSync(dirname(foreignStore), { recursive: true });
writeFileSync(foreignStore, "");
// 더미는 표준 입력이 닫히지 않는 한 산다(반복 타이머 금지 규칙을 지킨다).
const decoyScript = join(configDir, "decoy.mjs");
writeFileSync(decoyScript, `
import { open, readFileSync } from "node:fs";
open(${JSON.stringify(foreignStore)}, "r");
const stdin = await new Promise((resolve) => process.stdin.on("readable", resolve));
await new Promise((resolve, reject) => {
  process.stdin.on("end", resolve);
  process.stdin.on("error", reject);
  void stdin;
});
`);
const decoy = spawn(process.execPath, [decoyScript], { argv0: "com.apple.WebKit.WebContent", stdio: ["pipe", "ignore", "ignore"] });
// 희생제: 죽은 실행의 기록에 주입할 미기록 WebKit 흉내(수확 경로의 결정적 증명).
const victimScript = join(configDir, "victim.mjs");
writeFileSync(victimScript, "process.stdin.on('end', () => process.exit(0));\nvoid readFileSync(0);\n");
const victim = spawn(process.execPath, [victimScript], { argv0: "com.apple.WebKit.GPU", stdio: ["pipe", "ignore", "ignore"] });

let app = null;
try {
  const baseline = webkitProcesses();
  const oursNow = () => new Map([...webkitProcesses()].filter(([pid]) => !baseline.has(pid)
    && pid !== decoy.pid && pid !== victim.pid));

  // ── 케이스 1: 호스트 생존 중 자식(WebContent) 하나를 외부 킬 → 교체 스폰 → 기록 갱신.
  app = await startApp(binary, configDir);
  await waitUntil(() => oursNow().size >= 1, "the first run created WebKit children");
  const firstOurs = oursNow();
  const firstRecord = readRecords(configDir);
  check(firstRecord !== null, "case 1: the host records its WebKit children in its configuration directory");
  if (firstRecord !== null) {
    check([...firstOurs.keys()].every((pid) => firstRecord.children.some((child) => child.pid === pid)),
      `case 1: the record names exactly this run's children (${JSON.stringify(firstRecord.children.map((c) => c.pid))} vs ${JSON.stringify([...firstOurs.keys()])})`);
  }
  const contentPid = [...firstOurs].find(([, kind]) => kind === "WebContent")?.[0];
  if (contentPid) {
    process.kill(contentPid, "SIGKILL");
    const replaced = await waitUntil(() => {
      const next = oursNow();
      return !next.has(contentPid) && [...next.values()].includes("WebContent");
    }, "a killed WebContent child was not replaced while the host lives").catch(() => null);
    check(replaced !== null, "case 1: WebKit replaces an externally killed child while the host lives");
    if (replaced !== null) {
      await waitUntil(() => {
        const record = readRecords(configDir);
        return record !== null && !record.children.some((child) => child.pid === contentPid)
          && [...oursNow().keys()].every((pid) => record.children.some((child) => child.pid === pid));
      }, "the record was not refreshed with the replacement child", 20000).then(
        () => check(true, "case 1: the record drops the dead child and names the replacement"),
        (error) => check(false, `case 1: the record was not refreshed with the replacement child (${error.message})`));
    }
  } else {
    check(false, "case 1: the run exposed no WebContent child to kill externally");
  }

  // ── 케이스 2+4: 호스트 사망 + 기록 중 하나는 이미 죽은 혼합 상태 → 살아 있는 것만 수확.
  const beforeCrash = oursNow();
  app.client.close();
  app.child.kill("SIGKILL");
  await waitUntil(() => app.child.exitCode !== null || app.child.signalCode !== null, "the killed application did not exit", 5000);
  app = null;
  const record = readRecords(configDir);
  if (record !== null && record.children.length >= 1) {
    const preKilled = record.children[0].pid;
    if (alive(preKilled)) process.kill(preKilled, "SIGKILL");
    check(!alive(preKilled), "case 2: one recorded child is dead before the restart (the mixed state)");
    // 실제 기록 스키마(pid, kind, lstart) 그대로 — lstart 는 희생제의 실제 시작 시각.
    const victimLstart = execFileSync("ps", ["-o", "lstart=", "-p", String(victim.pid)], { encoding: "utf8" }).trim();
    record.children.push({ pid: victim.pid, kind: "GPU", lstart: victimLstart });
    writeFileSync(recordsFile(configDir), JSON.stringify(record));
    const realLeftovers = [...beforeCrash].filter(([pid]) => alive(pid));
    console.log(`INFO webkit-reaping the crash left ${realLeftovers.length} real WebKit leftovers this run`);
    app = await startApp(binary, configDir);
    await waitUntil(() => webkitProcesses().size >= 1, 'the restarted application settled', 3000).catch(() => {});
    const survivors = realLeftovers.filter(([pid]) => alive(pid));
    check(survivors.length === 0, `case 2: the restart reaped the recorded real leftovers (survivors: ${JSON.stringify(survivors)})`);
    check(!alive(victim.pid), "case 4: the restart killed the recorded WebKit-named victim (the reap path works)");
    check(alive(decoy.pid), "case 3: the unrecorded foreign WebKit decoy survives every path untouched");
    const after = readRecords(configDir);
    const nextOurs = oursNow();
    check(after !== null && nextOurs.size >= 1
      && [...nextOurs.keys()].every((pid) => after.children.some((child) => child.pid === pid)),
      "case 2: the new run rewrote the record with its own children");
    await app.client.request("command.run", { window: "main", name: "host.quit", params: {} });
    await waitUntil(() => app.child.exitCode !== null || app.child.signalCode !== null, "the second run did not quit", 10000);
    app.client.close();
    app = null;
  } else {
    check(false, "case 2: no record to build the mixed state (recorded in case 1)");
  }
} catch (error) {
  failures++;
  console.log(`FAIL webkit-reaping ${error.message}`);
} finally {
  decoy.kill("SIGKILL");
  victim.kill("SIGKILL");
  if (app !== null) {
    app.child.kill("SIGKILL");
    app.client.close?.();
  }
  rmSync(configDir, { recursive: true, force: true });
}


  if (failures === failuresBefore) console.log(`PASS webkit-reaping ${appName}`);
}

for (const appName of selected) {
  const binary = BINARIES[appName];
  if (!existsSync(binary)) {
    console.log(`SKIP webkit-reaping ${appName}: the debug application is not built`);
    continue;
  }
  await runCaseMatrix(appName, binary);
}
process.exit(failures === 0 ? 0 : 1);
