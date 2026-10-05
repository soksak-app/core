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

test("the page processes of a host are the WebContent children of its record", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pageProcesses } = await import("../stall-sample.mjs");
  const dir = mkdtempSync(join(tmpdir(), "soksak-stall-"));
  writeFileSync(join(dir, "webkit-children.json"), JSON.stringify({ host_pid: 10, children: [
    { pid: 11, kind: "GPU" }, { pid: 12, kind: "WebContent" }, { pid: 13, kind: "WebContent" },
  ] }));
  assert.deepEqual(pageProcesses(dir), [12, 13]);
  assert.throws(() => pageProcesses(join(dir, "missing")), /webkit-children\.json/);
});

test("a page that does not reply records the host and its page processes and names the records", async () => {
  const { sampleStall } = await import("../stall-sample.mjs");
  const sampled = [];
  const files = sampleStall({ host: 10, pages: [12, 13], directory: "/x/logs", time: 7,
    sample: (pid, file) => { sampled.push([pid, file]); return file; } });
  assert.deepEqual(sampled, [[10, "/x/logs/stall-10-7.txt"], [12, "/x/logs/stall-10-7-page-12.txt"], [13, "/x/logs/stall-10-7-page-13.txt"]]);
  assert.deepEqual(files, sampled.map(([, file]) => file));
});

test("a request that the page did not answer names the stall records or why they could not be made", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { EndpointError } = await import("@soksak/client");
  const { Session } = await import("../app.mjs");
  const configDir = mkdtempSync(join(tmpdir(), "soksak-stall-config-"));
  const client = { endpoint: { pid: 999999 }, request: async () => { throw new EndpointError({ code: -32603, message: "main did not reply within 10000 ms" }); } };
  const s = new Session({ name: "tauriv2", configDir }, client);
  // 이 설정 폴더에는 WebKit 자식 기록이 없으므로 기록하지 못한 까닭이 오류에 남는다.
  await assert.rejects(s.request("status.get", { name: "core.verify" }),
    /^EndpointError: tauriv2 status\.get core\.verify: main did not reply within 10000 ms; sampling the host failed: .*webkit-children\.json: ENOENT/);
});

test("a page process that already ended does not cost the records of the host and the other pages", async () => {
  const { sampleStall } = await import("../stall-sample.mjs");
  const results = sampleStall({ host: 10, pages: [12, 13], directory: "/x/logs", time: 7, sample: (pid, file) => {
    if (pid === 12) throw new Error("sample 12 exited with 255: process 12 no longer appears to be running");
    return file;
  } });
  assert.deepEqual(results, [
    "/x/logs/stall-10-7.txt",
    "page 12 not sampled: sample 12 exited with 255: process 12 no longer appears to be running",
    "/x/logs/stall-10-7-page-13.txt",
  ]);
});
