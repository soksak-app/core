import assert from "node:assert/strict";
import test from "node:test";
import { restoreFrontmost, sessionBaseline } from "../frontmost.mjs";

// 활성 애플리케이션을 읽고 바꾸는 동작을 가짜로 주입하여 검사 뒤 기준 복원을 검사한다.
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
  assert.deepEqual(await restoreFrontmost({ name: "wailsv3", baseline: 10, host: 20, hosts: [20, 21], ...f }), { before: 10, after: 10 });
  assert.deepEqual(f.calls, ["read", "read"]);
});

test("an application the user brought forward is reported without activating anything", async () => {
  // 검사는 다른 애플리케이션을 활성화하지 않으므로 다른 애플리케이션이 맨 앞이면 사용자가 바꾼 것이다.
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
  const f = fake([20]);
  const describe = (pid) => `pid ${pid}, soksak-wailsv3, app.soksak.wailsv3`;
  assert.throws(() => sessionBaseline({ hosts: [{ name: "wailsv3", pid: 20 }, { name: "tauriv2", pid: 21 }], read: f.read, describe }),
    new Error("the frontmost application before the checks is tested host wailsv3 (pid 20, soksak-wailsv3, app.soksak.wailsv3); " +
      "tested hosts: wailsv3 pid 20, tauriv2 pid 21; nothing was measured. Bring another application to the front and run the checks again."));
  assert.deepEqual(f.calls, ["read"]);
});

test("a session whose frontmost application before the checks is not a tested host takes it as the baseline", () => {
  const f = fake([10]);
  assert.equal(sessionBaseline({ hosts: [{ name: "wailsv3", pid: 20 }, { name: "tauriv2", pid: 21 }], read: f.read,
    describe: () => assert.fail("only a refused baseline is described") }), 10);
});
