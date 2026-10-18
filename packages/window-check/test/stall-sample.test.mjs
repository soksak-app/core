// When a request does not answer within the limit, the check keeps the stacks of the host process at that time (F69).
// What the main thread did while it did not answer can be seen only at that moment.
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

test("the page processes of a host are the running WebContent services of its launchd domain", async () => {
  const { pageProcesses } = await import("../stall-sample.mjs");
  const stdout = "pid/10 = {\n\tservices = {\n\t\t       0      - \tcom.apple.WebKit.WebContent\n" +
    "\t\t      11      - \tcom.apple.WebKit.GPU.A\n\t\t      12      - \tcom.apple.WebKit.WebContent.B\n" +
    "\t\t      13      - \tcom.apple.WebKit.WebContent.C\n\t}\n\tendpoints = {\n\t\t   14 com.apple.WebKit.WebContent.D\n\t}\n}\n";
  const calls = [];
  assert.deepEqual(pageProcesses(10, (command, args) => { calls.push([command, ...args]); return { status: 0, stdout }; }), [12, 13]);
  assert.deepEqual(calls, [["/bin/launchctl", "print", "pid/10"]]);
  assert.throws(() => pageProcesses(10, () => ({ status: 113, stderr: "Could not print domain\n" })),
    /^Error: launchctl print pid\/10 exited with 113: Could not print domain$/);
});

test("a page that does not reply records the host and its page processes and names the records", async () => {
  const { sampleStall } = await import("../stall-sample.mjs");
  const sampled = [];
  const files = sampleStall({ host: 10, pages: [12, 13], directory: "/x/logs", time: 7,
    sample: (pid, file) => { sampled.push([pid, file]); return file; } });
  assert.deepEqual(sampled, [[10, "/x/logs/stall-10-7.txt"], [12, "/x/logs/stall-10-7-page-12.txt"], [13, "/x/logs/stall-10-7-page-13.txt"]]);
  assert.deepEqual(files, sampled.map(([, file]) => file));
});

test("a request that the page did not answer names the stall records or why they could not be made", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { EndpointError } = await import("@soksak/client");
  const { Session } = await import("../app.mjs");
  const configDir = mkdtempSync(join(tmpdir(), "soksak-stall-config-"));
  t.after(() => rmSync(configDir, { recursive: true }));
  const client = { endpoint: { pid: 999999 }, request: async () => { throw new EndpointError({ code: -32603, message: "the document did not reply within 10000 ms" }); } };
  const s = new Session({ name: "tauriv2", configDir }, client);
  // No process 999999 runs, so sample cannot record the host and the reason stays in the error.
  await assert.rejects(s.request("status.get", { name: "core.verify" }),
    /^EndpointError: tauriv2 status\.get core\.verify: the document did not reply within 10000 ms; sampling the host failed: sample 999999 /);
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

test("the path of the dump of the host is stored as an event and its position is named", async () => {
  const { announceStall } = await import("../stall-sample.mjs");
  const calls = [];
  const text = await announceStall(async (method, params) => { calls.push([method, params]); return { boot: "b1", seq: 9 }; }, "main",
    ["/x/logs/stall-10-7.txt", "page 12 not sampled: gone", "/x/logs/stall-10-7-page-13.txt"]);
  assert.deepEqual(calls, [["diagnostics.stall.dump", { window: "main", path: "/x/logs/stall-10-7.txt" }]]);
  assert.equal(text, "host.stall.dump at b1:9");
});

test("a host that refuses the dump event is named in the message instead of hiding it", async () => {
  const { announceStall } = await import("../stall-sample.mjs");
  const text = await announceStall(async () => { throw new Error("path does not name a file: /x"); }, "main", ["/x/logs/stall-10-7.txt"]);
  assert.equal(text, "host.stall.dump not stored: path does not name a file: /x");
});

test("a host that does not answer the dump event within the bound is named in the message", async () => {
  const { announceStall } = await import("../stall-sample.mjs");
  const text = await announceStall(() => new Promise(() => {}), "main", ["/x/logs/stall-10-7.txt"], 10);
  assert.equal(text, "host.stall.dump not stored: no answer within 10 ms");
});
