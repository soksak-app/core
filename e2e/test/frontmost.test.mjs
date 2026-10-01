import assert from "node:assert/strict";
import test from "node:test";
import { restoreFrontmost } from "../frontmost.mjs";

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
  const result = await restoreFrontmost({ name: "tauriv2", baseline: 10, host: 20, ...f });
  assert.deepEqual(f.calls, ["read", "activate 10", "inactive", "read"]);
  assert.deepEqual(result, { before: 20, after: 10 });
});

test("a check that leaves the baseline frontmost changes nothing", async () => {
  const f = fake([10, 10]);
  assert.deepEqual(await restoreFrontmost({ name: "wailsv3", baseline: 10, host: 20, ...f }), { before: 10, after: 10 });
  assert.deepEqual(f.calls, ["read", "read"]);
});

test("a check that leaves another application frontmost fails without activating it", async () => {
  const f = fake([30, 30]);
  await assert.rejects(restoreFrontmost({ name: "tauriv2", baseline: 10, host: 20, ...f }),
    /tauriv2: application 30 is frontmost after the check instead of the baseline 10 \(frontmost before restoring: 30\)/);
  assert.deepEqual(f.calls, ["read", "read"]);
});

test("a baseline that the restore does not reach fails the check", async () => {
  const f = fake([20, 20]);
  await assert.rejects(restoreFrontmost({ name: "tauriv2", baseline: 10, host: 20, ...f }),
    /tauriv2: application 20 is frontmost after the check instead of the baseline 10 \(frontmost before restoring: 20\)/);
});
