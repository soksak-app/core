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

test("a failing session audit closes every session of the same check and reports every failure", { timeout: 10000 }, async () => {
  reset();
  const probe = context();
  const order = [];
  for (const [index, name] of ["wailsv3", "tauriv2", "mygo"].entries()) {
    endpoint.application = name;
    const session = await open(probe, { ...app, name });
    session.cleanup(() => {
      order.push(name);
      if (index < 2) throw new Error(`${name}: owned cleanup failed`);
    });
  }
  let failure;
  try { await probe.finish(); } catch (error) { failure = error; }
  assert.equal(closed, 3, "an earlier failed audit must not retain later endpoint connections or window-check slots");
  assert.deepEqual(order, ["wailsv3", "tauriv2", "mygo"]);
  assert.ok(failure instanceof AggregateError, "all session failures must be returned together");
  assert.deepEqual(failure.errors.map(error => error.message), [
    "wailsv3: owned cleanup failed", "tauriv2: owned cleanup failed",
  ]);
  for (const name of ["wailsv3", "tauriv2"]) {
    assert.ok(probe.diagnostics.some(line => line.includes(`${name}: owned cleanup failed`)));
  }
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

for (const failedIndex of [0, 2]) {
  test(`parent session audit failure ${failedIndex === 0 ? "first" : "last"} preserves every app's owned recording`, { timeout: 10000 }, async () => {
    reset();
    const probe = context();
    const recordings = [];
    const original = new Error(`session ${failedIndex} audit failed`);
    for (const [index, name] of ["wailsv3", "tauriv2", "mygo"].entries()) {
      endpoint.application = name;
      const configDir = join(root, `cohort-${failedIndex}-${name}`);
      const session = await open(probe, { ...app, name, configDir });
      const recording = join(configDir, "logs", "captures", "owned-recording");
      mkdirSync(recording, { recursive: true });
      writeFileSync(join(recording, "original-frame.bgra"), `${name}: original capture bytes`);
      session.recordings.add(realpathSync(recording));
      recordings.push({ name, recording });
      session.cleanup(() => { if (index === failedIndex) throw original; });
    }
    await assert.rejects(probe.finish(), error => error === original);
    assert.equal(closed, 3, "all sessions must close despite the shared parent audit failure");
    for (const { name, recording } of recordings) {
      assert.equal(readFileSync(join(recording, "original-frame.bgra"), "utf8"), `${name}: original capture bytes`,
        "a successful sibling audit must not dispose evidence before the entire parent audit succeeds");
      assert.ok(probe.diagnostics.some(line => line.includes(`kept recording: ${recording}`)));
    }
  });
}

test("all successful session audits precede disposal and remove only that parent's owned recordings", { timeout: 10000 }, async () => {
  reset();
  const probe = context();
  const recordings = [];
  for (const [index, name] of ["wailsv3", "tauriv2", "mygo"].entries()) {
    endpoint.application = name;
    const configDir = join(root, `cohort-success-${name}`);
    const prior = join(configDir, "logs", "captures", "prior-recording");
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, "existing.txt"), "prior evidence");
    const session = await open(probe, { ...app, name, configDir });
    const recording = join(configDir, "logs", "captures", "owned-recording");
    mkdirSync(recording, { recursive: true });
    writeFileSync(join(recording, "original-frame.bgra"), `${name}: original capture bytes`);
    session.recordings.add(realpathSync(recording));
    recordings.push({ recording, prior });
    session.cleanup(() => {
      if (index === 2) for (const entry of recordings) {
        assert.equal(readFileSync(join(entry.recording, "original-frame.bgra"), "utf8").endsWith("original capture bytes"), true,
          "every recording must still exist during the last session audit");
      }
    });
  }
  await probe.finish();
  assert.equal(closed, 3);
  for (const { recording, prior } of recordings) {
    assert.throws(() => readFileSync(join(recording, "original-frame.bgra")), { code: "ENOENT" });
    assert.equal(readFileSync(join(prior, "existing.txt"), "utf8"), "prior evidence");
  }
});
