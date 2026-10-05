// 요청이 한도 안에 답하지 않으면 그때 호스트 프로세스의 stack 을 남긴다(F69). 답하지 않은 동안 main thread 가 무엇을
// 했는지는 그 순간에만 볼 수 있다.
import assert from "node:assert/strict";
import test from "node:test";
import { within } from "../app.mjs";
import { sampleProcess } from "../stall-sample.mjs";

test("a request that does not answer within its limit records what the host was doing and names the record", async () => {
  const never = new Promise(() => {});
  let sampled = 0;
  await assert.rejects(within(never, 10, "wailsv3 status.get host.windows", async () => { sampled++; return "/tmp/stall-1.txt"; }),
    /^Error: wailsv3 status\.get host\.windows did not answer within 10 ms; the host's threads at that moment: \/tmp\/stall-1\.txt$/);
  assert.equal(sampled, 1);
});

test("a failed sample is named in the timeout instead of hiding it", async () => {
  await assert.rejects(within(new Promise(() => {}), 10, "probe", async () => { throw new Error("sample: no such process"); }),
    /^Error: probe did not answer within 10 ms; sampling the host failed: sample: no such process$/);
});

test("a request that answers in time does not sample", async () => {
  let sampled = 0;
  assert.equal(await within(Promise.resolve(7), 1000, "probe", async () => { sampled++; return ""; }), 7);
  assert.equal(sampled, 0);
});

test("sampleProcess runs sample on the host process into the given file and reports its failure", () => {
  const calls = [];
  const path = sampleProcess(4321, "/x/stall.txt", (command, args) => { calls.push([command, ...args]); return { status: 0, stderr: "" }; });
  assert.equal(path, "/x/stall.txt");
  assert.deepEqual(calls, [["/usr/bin/sample", "4321", "2", "-file", "/x/stall.txt"]]);
  assert.throws(() => sampleProcess(4321, "/x/stall.txt", () => ({ status: 1, stderr: "sample cannot examine process 4321\n" })),
    /^Error: sample 4321 exited with 1: sample cannot examine process 4321$/);
});
