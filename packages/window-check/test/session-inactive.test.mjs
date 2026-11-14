import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { playApplication } from "../fixtures/endpoint-player.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-session-inactive-")));
process.env.TMPDIR = root;
delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
const { open } = await import("../app.mjs");
test.after(() => rmSync(root, { recursive: true, force: true }));

/** The reading of host.window of an application that is not active and has registered the observation of its activations. */
const observed = () => ({ active: false, activationObservation: { registered: true, count: "0" } });

/**
 * The application `name` whose endpoint is the case player of `name`: "window-check-open-idle" for a session that reads nothing,
 * "window-check-inactive-observation" with the `values` of the two readings, or "window-check-inactive-preparation".
 */
async function setup(t, caseName, application, values) {
  const player = await playApplication(t, caseName, application, values === undefined ? {} : { values });
  return { player, app: { name: application, binary: process.execPath, configDir: player.configDir } };
}
const idle = (t, application) => setup(t, "window-check-open-idle", application);
const observing = (t, values, application = "mygo") => setup(t, "window-check-inactive-observation", application, values);

/** Resolves when the connection of the session to the player has ended. */
async function closed(player) {
  await Promise.all([...player.connections].map((socket) => once(socket, "close")));
  assert.equal(player.connections.size, 0, "the connection of the session stayed open");
}

/** Rewrites endpoint.json of the application as another process of the same application would write it. */
function rewriteEndpoint(configDir, change) {
  const file = join(configDir, "endpoint.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...change }));
}

function context() {
  const afters = [], diagnostics = [];
  return { name: "inactive owner", passed: true, diagnostics, diagnostic(line) { diagnostics.push(line); }, after(fn) { afters.push(fn); },
    async finish() { for (const fn of afters) await fn(); } };
}

test("ordinary sessions do not require activation observation", { timeout: 10000 }, async (t) => {
  const { app } = await idle(t, "mygo");
  const check = context();
  try { await open(check, app); } finally { await check.finish(); }
});

test("a failing session audit closes every session of the same check and reports every failure", { timeout: 10000 }, async (t) => {
  const probe = context();
  const order = [];
  const players = [];
  for (const [index, name] of ["wailsv3", "tauriv2", "mygo"].entries()) {
    const { app, player } = await idle(t, name);
    players.push(player);
    const session = await open(probe, app);
    session.cleanup(() => {
      order.push(name);
      if (index < 2) throw new Error(`${name}: owned cleanup failed`);
    });
  }
  let failure;
  try { await probe.finish(); } catch (error) { failure = error; }
  for (const player of players) await closed(player);
  assert.deepEqual(order, ["wailsv3", "tauriv2", "mygo"]);
  assert.ok(failure instanceof AggregateError, "all session failures must be returned together");
  assert.deepEqual(failure.errors.map(error => error.message), [
    "wailsv3: owned cleanup failed", "tauriv2: owned cleanup failed",
  ]);
  for (const name of ["wailsv3", "tauriv2"]) {
    assert.ok(probe.diagnostics.some(line => line.includes(`${name}: owned cleanup failed`)));
  }
});

test("inactive session snapshots before body and verifies after own cleanup", { timeout: 10000 }, async (t) => {
  const { app, player } = await observing(t, { before: observed(), after: observed() });
  const check = context();
  const order = [];
  try {
    const session = await open(check, app, { inactive: true });
    session.cleanup(() => { order.push("own cleanup"); });
  } finally { await check.finish(); }
  await closed(player);
  assert.deepEqual(order, ["own cleanup"]);
  const { pid, started } = JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8"));
  assert.equal(player.requests.length, 2, "the observation precedes the body and follows the cleanup");
  assert.ok(check.diagnostics.some(line => line.includes(`pid=${pid}`) && line.includes(`started=${started}`) &&
    line.includes("activation count 0→0") && line.includes("registered=true active=false")), "successful proof must be recorded explicitly");
});

for (const [label, alter] of [
  ["missing capability", (state) => { delete state.activationObservation; }],
  ["unregistered capability", (state) => { state.activationObservation.registered = false; }],
  ["noncanonical decimal count", (state) => { state.activationObservation.count = "00"; }],
  ["uint64 overflow", (state) => { state.activationObservation.count = "18446744073709551616"; }],
  ["numeric count", (state) => { state.activationObservation.count = 0; }],
  ["active application", (state) => { state.active = true; }],
]) {
  test(`inactive preparation rejects ${label}`, { timeout: 10000 }, async (t) => {
    const state = observed();
    alter(state);
    const { app, player } = await setup(t, "window-check-inactive-preparation", "mygo", { state });
    const check = context();
    try {
      await assert.rejects(open(check, app, { inactive: true }), /activation|inactive|active|registered|count/i);
      await closed(player);
    } finally { await check.finish(); }
  });
}

for (const [label, alter, change] of [
  ["activation during cleanup", (state) => { state.activationObservation.count = "1"; }],
  ["active at end", (state) => { state.active = true; }],
  // The process of the test runner is another running process than the one that the endpoint names.
  ["changed endpoint PID", () => {}, () => ({ pid: process.ppid })],
  ["changed endpoint boot", () => {}, () => ({ started: new Date(Date.now() + 120_000).toISOString() })],
  ["lost registration", (state) => { state.activationObservation.registered = false; }],
]) {
  test(`inactive completion rejects ${label}`, { timeout: 10000 }, async (t) => {
    const after = observed();
    alter(after);
    const { app, player } = await observing(t, { before: observed(), after });
    const check = context();
    let finishing = false;
    try {
      const session = await open(check, app, { inactive: true });
      if (change) session.cleanup(() => rewriteEndpoint(app.configDir, change()));
      finishing = true;
      await assert.rejects(check.finish(), /activation|inactive|active|registered|endpoint|boot/i);
      await closed(player);
    } finally { if (!finishing) await check.finish(); }
  });
}

test("failed inactive cleanup preserves owned recording evidence", { timeout: 10000 }, async (t) => {
  const after = observed();
  after.activationObservation.count = "1";
  const { app, player } = await observing(t, { before: observed(), after });
  const check = context();
  const session = await open(check, app, { inactive: true });
  const recording = join(app.configDir, "logs", "captures", "inactive-failed-recording");
  mkdirSync(recording, { recursive: true });
  writeFileSync(join(recording, "original-frame.bgra"), "original capture bytes");
  session.recordings.add(realpathSync(recording));
  await assert.rejects(check.finish(), /activation count changed/);
  assert.equal(readFileSync(join(recording, "original-frame.bgra"), "utf8"), "original capture bytes");
  await closed(player);
});

for (const failedIndex of [0, 2]) {
  test(`parent session audit failure ${failedIndex === 0 ? "first" : "last"} preserves every app's owned recording`, { timeout: 10000 }, async (t) => {
    const probe = context();
    const recordings = [];
    const players = [];
    const original = new Error(`session ${failedIndex} audit failed`);
    for (const [index, name] of ["wailsv3", "tauriv2", "mygo"].entries()) {
      const { app, player } = await idle(t, name);
      players.push(player);
      const session = await open(probe, app);
      const recording = join(app.configDir, "logs", "captures", "owned-recording");
      mkdirSync(recording, { recursive: true });
      writeFileSync(join(recording, "original-frame.bgra"), `${name}: original capture bytes`);
      session.recordings.add(realpathSync(recording));
      recordings.push({ name, recording });
      session.cleanup(() => { if (index === failedIndex) throw original; });
    }
    await assert.rejects(probe.finish(), error => error === original);
    for (const player of players) await closed(player);
    for (const { name, recording } of recordings) {
      assert.equal(readFileSync(join(recording, "original-frame.bgra"), "utf8"), `${name}: original capture bytes`,
        "a successful sibling audit must not dispose evidence before the entire parent audit succeeds");
      assert.ok(probe.diagnostics.some(line => line.includes(`kept recording: ${recording}`)));
    }
  });
}

test("all successful session audits precede disposal and remove only that parent's owned recordings", { timeout: 10000 }, async (t) => {
  const probe = context();
  const recordings = [];
  const players = [];
  for (const [index, name] of ["wailsv3", "tauriv2", "mygo"].entries()) {
    const { app, player } = await idle(t, name);
    players.push(player);
    const prior = join(app.configDir, "logs", "captures", "prior-recording");
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, "existing.txt"), "prior evidence");
    const session = await open(probe, app);
    const recording = join(app.configDir, "logs", "captures", "owned-recording");
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
  for (const player of players) await closed(player);
  for (const { recording, prior } of recordings) {
    assert.throws(() => readFileSync(join(recording, "original-frame.bgra")), { code: "ENOENT" });
    assert.equal(readFileSync(join(prior, "existing.txt"), "utf8"), "prior evidence");
  }
});
