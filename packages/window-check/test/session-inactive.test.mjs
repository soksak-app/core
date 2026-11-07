import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-session-inactive-")));
process.env.TMPDIR = root;
delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
const binary = join(root, "probe-binary");
writeFileSync(binary, "");
const app = { name: "mygo", binary, configDir: join(root, "config") };
let state, endpoint, reads, endpointReads, closed;
function reset() {
  state = { active: false, activationObservation: { registered: true, count: "0" } };
  endpoint = { pid: process.pid, application: "mygo", executable: binary,
    started: new Date(Date.now() + 60_000).toISOString() };
  reads = []; endpointReads = 0; closed = 0;
}
class EndpointError extends Error {}
mock.module("@soksak/client", { exports: {
  EndpointError,
  readEndpoint: async () => { endpointReads++; return structuredClone(endpoint); },
  connect: async () => ({ endpoint: structuredClone(endpoint), close() { closed++; },
    async request(method, params) {
      if (method === "status.get" && params.name === "host.window") {
        reads.push("window");
        return structuredClone(state);
      }
      return null;
    } }),
} });
mock.module("../event-log.mjs", { exports: {
  readEventErrors: () => ({ errors: [] }), sessionEventBoot: () => 0, sessionEventStart: () => ({}),
} });
const { open } = await import("../app.mjs");
function context() {
  const afters = [], diagnostics = [];
  return { name: "inactive owner", passed: true, diagnostics, diagnostic(line) { diagnostics.push(line); }, after(fn) { afters.push(fn); },
    async finish() { for (const fn of afters) await fn(); } };
}
test.after(() => rmSync(root, { recursive: true, force: true }));

test("ordinary sessions do not require activation observation", { timeout: 10000 }, async () => {
  reset(); delete state.activationObservation;
  const t = context();
  try { await open(t, app); } finally { await t.finish(); }
  assert.deepEqual(reads, []);
  assert.equal(endpointReads, 0);
});

test("inactive session snapshots before body and verifies after own cleanup", { timeout: 10000 }, async () => {
  reset();
  const t = context();
  try {
    const session = await open(t, app, { inactive: true });
    assert.deepEqual(reads, ["window"], "initial observation must precede the test body");
    session.cleanup(() => { reads.push("own cleanup"); });
  } finally { await t.finish(); }
  assert.deepEqual(reads, ["window", "own cleanup", "window"]);
  assert.ok(endpointReads >= 1, "cleanup must reread the actual endpoint, not its cached client snapshot");
  assert.equal(closed, 1);
  assert.ok(t.diagnostics.some(line => line.includes(`pid=${endpoint.pid}`) && line.includes(`started=${endpoint.started}`) &&
    line.includes("activation count 0→0") && line.includes("registered=true active=false")), "successful proof must be recorded explicitly");
});

for (const [label, alter] of [
  ["missing capability", () => { delete state.activationObservation; }],
  ["unregistered capability", () => { state.activationObservation.registered = false; }],
  ["noncanonical decimal count", () => { state.activationObservation.count = "00"; }],
  ["uint64 overflow", () => { state.activationObservation.count = "18446744073709551616"; }],
  ["numeric count", () => { state.activationObservation.count = 0; }],
  ["active application", () => { state.active = true; }],
]) {
  test(`inactive preparation rejects ${label}`, { timeout: 10000 }, async () => {
    reset(); alter();
    const t = context();
    try {
      await assert.rejects(open(t, app, { inactive: true }), /activation|inactive|active|registered|count/i);
      assert.equal(closed, 1, "preparation rejection releases the connection immediately");
    } finally { await t.finish(); }
  });
}

for (const [label, alter] of [
  ["activation during cleanup", () => { state.activationObservation.count = "1"; }],
  ["active at end", () => { state.active = true; }],
  ["changed endpoint PID", () => { endpoint.pid++; }],
  ["changed endpoint boot", () => { endpoint.started = new Date(Date.now() + 120_000).toISOString(); }],
  ["lost registration", () => { state.activationObservation.registered = false; }],
]) {
  test(`inactive completion rejects ${label}`, { timeout: 10000 }, async () => {
    reset();
    const t = context();
    let finishing = false;
    try {
      const session = await open(t, app, { inactive: true });
      session.cleanup(alter);
      finishing = true;
      await assert.rejects(t.finish(), /activation|inactive|active|registered|endpoint|boot/i);
      assert.equal(closed, 1, "failed final verification still closes the connection");
    } finally { if (!finishing) await t.finish(); }
  });
}


test("failed inactive cleanup preserves owned recording evidence", { timeout: 10000 }, async () => {
  reset();
  const t = context();
  const session = await open(t, app, { inactive: true });
  const recording = join(app.configDir, "logs", "captures", "inactive-failed-recording");
  mkdirSync(recording, { recursive: true });
  writeFileSync(join(recording, "original-frame.bgra"), "original capture bytes");
  session.recordings.add(realpathSync(recording));
  session.cleanup(() => { state.activationObservation.count = "1"; });
  await assert.rejects(t.finish(), /activation count changed/);
  assert.equal(readFileSync(join(recording, "original-frame.bgra"), "utf8"), "original capture bytes");
  assert.equal(closed, 1);
});
