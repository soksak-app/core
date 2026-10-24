import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseSessionBaseline,
  SESSION_BASELINE_ENV,
  sessionBaseline,
  sessionBaselineEnvironment,
  sessionBaselineFromEnvironment,
} from "../frontmost.mjs";

const identity = (pid) => ({ pid, name: `app-${pid}`, bundle: `org.example.app-${pid}` });

test("isolated host workers restore the baseline captured once by their session", { timeout: 10000 }, () => {
  const baseline = sessionBaseline({ hosts: [], read: () => identity(100) });
  const sharedEnv = sessionBaselineEnvironment({ env: {}, hosts: [], read: () => baseline });
  const worker = `import { parseSessionBaseline, sessionBaseline, restoreFrontmost } from ${JSON.stringify(new URL("../frontmost.mjs", import.meta.url).href)};
const baseline = process.env.${SESSION_BASELINE_ENV}
  ? parseSessionBaseline(process.env.${SESSION_BASELINE_ENV})
  : sessionBaseline({ hosts: [], read: () => ({ pid: Number(process.env.FIXTURE_FRONTMOST_PID), name: 'changed app', bundle: 'org.example.changed' }) });
let current = Number(process.env.FIXTURE_FRONTMOST_PID);
let activated = null;
await restoreFrontmost({ name: process.env.SOKSAK_APP, baseline: baseline.pid, host: current, hosts: [current],
  read: () => current, activate: (pid) => { activated = pid; current = pid; }, inactive: async () => {} });
process.stdout.write(JSON.stringify({ app: process.env.SOKSAK_APP, baseline, activated }));`;

  const observed = [
    ["wailsv3", 201],
    ["tauriv2", 302],
  ].map(([app, currentPid]) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", worker], {
      encoding: "utf8",
      env: { ...sharedEnv, SOKSAK_APP: app, FIXTURE_FRONTMOST_PID: String(currentPid) },
      timeout: 3000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });

  assert.deepEqual(observed, [
    { app: "wailsv3", baseline, activated: baseline.pid },
    { app: "tauriv2", baseline, activated: baseline.pid },
  ]);
});

test("the Node test runner propagates one baseline to isolated host test files", { timeout: 10000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "soksak-session-baseline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const baseline = identity(100);
  const env = sessionBaselineEnvironment({ env: {}, hosts: [], read: () => baseline });
  const setup = join(dir, "setup.mjs");
  writeFileSync(setup, `import assert from "node:assert/strict";
import { parseSessionBaseline } from ${JSON.stringify(new URL("../frontmost.mjs", import.meta.url).href)};
export async function globalSetup() {
  assert.deepEqual(parseSessionBaseline(process.env.${SESSION_BASELINE_ENV}), ${JSON.stringify(baseline)});
}\n`);
  const source = (app, frontmostPid) => `import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionBaseline, restoreFrontmost } from ${JSON.stringify(new URL("../frontmost.mjs", import.meta.url).href)};
test(${JSON.stringify(`${app} receives the shared baseline`)}, async () => {
  const baseline = parseSessionBaseline(process.env.${SESSION_BASELINE_ENV});
  assert.deepEqual(baseline, ${JSON.stringify(baseline)});
  let frontmost = ${frontmostPid};
  let restoredTo = null;
  const state = await restoreFrontmost({ name: ${JSON.stringify(app)}, baseline: baseline.pid, host: ${frontmostPid}, hosts: [${frontmostPid}],
    read: () => frontmost, activate: (pid) => { restoredTo = pid; frontmost = pid; }, inactive: async () => {} });
  assert.equal(restoredTo, baseline.pid);
  assert.equal(state.after, baseline.pid);
});\n`;
  const wails = join(dir, "wails.test.mjs");
  const tauri = join(dir, "tauri.test.mjs");
  writeFileSync(wails, source("wailsv3", 201));
  writeFileSync(tauri, source("tauriv2", 302));
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-global-setup=${setup}`, wails, tauri], {
    encoding: "utf8",
    env,
    timeout: 7000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /pass 2/);
});

test("baseline context parsing rejects incomplete identity and PID reuse", () => {
  assert.throws(() => parseSessionBaseline('{"pid":100,"name":"app-100"}'), /exactly a positive pid/);
  assert.throws(() => parseSessionBaseline('{"pid":0,"name":"app-0","bundle":"org.example.app-0"}'), /exactly a positive pid/);
  assert.throws(() => sessionBaselineFromEnvironment({
    [SESSION_BASELINE_ENV]: JSON.stringify(identity(100)),
  }, { hosts: [], identify: () => ({ ...identity(100), bundle: "org.example.reused" }) }), /not the same running application/);
  let recaptured = false;
  assert.throws(() => sessionBaselineEnvironment({
    env: { [SESSION_BASELINE_ENV]: "not-json" },
    read: () => { recaptured = true; return identity(200); },
  }), /not valid JSON/);
  assert.equal(recaptured, false);
});
