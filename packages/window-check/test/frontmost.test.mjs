import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSessionBaseline,
  restoreFrontmost,
  SESSION_BASELINE_ENV,
  sessionBaseline,
  sessionBaselineFromEnvironment,
  unlessCovered,
} from "../frontmost.mjs";

// Injects fakes for reading and changing the active application and checks the baseline restore after a check.
function fake(states) {
  const calls = [];
  return {
    calls,
    read: () => {
      calls.push("read");
      return states.shift();
    },
    activate: (pid) => calls.push(`activate ${pid}`),
    inactive: async () => calls.push("inactive"),
  };
}

test("a check that leaves the tested host frontmost restores the baseline", async () => {
  const f = fake([20, 10]);
  const result = await restoreFrontmost({ name: "tauriv2", baseline: 10, host: 20, hosts: [20, 21], ...f });
  assert.deepEqual(f.calls, ["read", "activate 10", "inactive", "read"]);
  assert.deepEqual(result, { before: 20, after: 10 });
});

test("a check that leaves the baseline frontmost changes nothing", async () => {
  const f = fake([10, 10]);
  assert.deepEqual(await restoreFrontmost({ name: "wailsv3", baseline: 10, hosts: [20, 21], ...f }), { before: 10, after: 10 });
  assert.deepEqual(f.calls, ["read", "read"]);
});

test("an application the user brought forward is reported without activating anything", async () => {
  const f = fake([30, 30]);
  assert.deepEqual(await restoreFrontmost({ name: "tauriv2", baseline: 10, host: 20, hosts: [20, 21], ...f }),
    { before: 30, after: 30 });
  assert.deepEqual(f.calls, ["read", "read"]);
});

test("another tested host left frontmost fails the check", async () => {
  const f = fake([21, 21]);
  await assert.rejects(restoreFrontmost({ name: "tauriv2", baseline: 10, host: 20, hosts: [20, 21], ...f }),
    /tauriv2: tested host 21 is frontmost after the check instead of the baseline 10 \(frontmost before restoring: 21\)/);
  assert.deepEqual(f.calls, ["read", "read"]);
});

test("a baseline that the restore does not reach fails the check", async () => {
  const f = fake([20, 20]);
  await assert.rejects(restoreFrontmost({ name: "tauriv2", baseline: 10, host: 20, hosts: [20, 21], ...f }),
    /tauriv2: tested host 20 is frontmost after the check instead of the baseline 10 \(frontmost before restoring: 20\)/);
});

test("a session whose frontmost application before the checks is a tested host is refused", () => {
  const f = fake([{ pid: 20, name: "soksak-wailsv3", bundle: "app.soksak.wailsv3" }]);
  const describe = (pid) => `pid ${pid}, soksak-wailsv3, app.soksak.wailsv3`;
  assert.throws(() => sessionBaseline({ hosts: [{ name: "wailsv3", pid: 20 }, { name: "tauriv2", pid: 21 }], read: f.read, describe }),
    new Error("the frontmost application before the checks is tested host wailsv3 (pid 20, soksak-wailsv3, app.soksak.wailsv3); " +
      "tested hosts: wailsv3 pid 20, tauriv2 pid 21; nothing was measured. Bring another application to the front and run the checks again."));
  assert.deepEqual(f.calls, ["read"]);
});

test("a session whose frontmost application before the checks is not a tested host takes it as the baseline", () => {
  const baseline = { pid: 10, name: "Finder", bundle: "com.apple.finder" };
  const f = fake([baseline]);
  assert.deepEqual(sessionBaseline({ hosts: [{ name: "wailsv3", pid: 20 }, { name: "tauriv2", pid: 21 }], read: f.read,
    describe: () => assert.fail("only a refused baseline is described") }), baseline);
});

test("a propagated baseline requires the same live process identity and excludes tested hosts", () => {
  const baseline = { pid: 10, name: "Finder", bundle: "com.apple.finder" };
  const env = { [SESSION_BASELINE_ENV]: JSON.stringify(baseline) };
  assert.deepEqual(sessionBaselineFromEnvironment(env, { identify: () => baseline }), baseline);
  assert.throws(() => sessionBaselineFromEnvironment(env, { identify: () => ({ ...baseline, bundle: "org.reused.pid" }) }), /not the same running application/);
  assert.throws(() => sessionBaselineFromEnvironment(env, { hosts: [{ name: "wailsv3", pid: 10 }], identify: () => baseline }), /tested host wailsv3/);
  assert.throws(() => parseSessionBaseline('{"pid":10,"name":"Finder"}'), /exactly a positive pid/);
  assert.throws(() => parseSessionBaseline('{"pid":10,"name":"Finder","bundle":"com.apple.finder","extra":true}'), /exactly a positive pid/);
});

test("a wait that fails while another window covers the window states the covering window", async () => {
  const timeout = new Error("no event line matched within 30000 ms");
  await assert.rejects(unlessCovered(async () => { throw timeout; }, async () => "Editor at {\"x\":0,\"y\":33,\"width\":1512,\"height\":892}"),
    (error) => {
      assert.match(error.message, /^the window is completely covered by Editor at \{"x":0,"y":33,"width":1512,"height":892\}/);
      assert.match(error.message, /Nothing was measured/);
      assert.equal(error.cause, timeout);
      return true;
    });
});

test("a wait that fails while no window covers the window fails with its own error", async () => {
  const timeout = new Error("no event line matched within 30000 ms");
  await assert.rejects(unlessCovered(async () => { throw timeout; }, async () => null), (error) => error === timeout);
});

test("a wait that succeeds returns its result without measuring the covering windows", async () => {
  let measured = false;
  assert.equal(await unlessCovered(async () => "line", async () => { measured = true; return null; }), "line");
  assert.equal(measured, false);
});
