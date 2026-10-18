import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { untilEndpoint } from "../endpoint-wait.mjs";

// A fake configuration folder: the host writes endpoint.json through a temporary file that it renames, so the fake does
// the same.
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "endpoint-wait-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function publish(dir, endpoint) {
  const temporary = join(dir, ".settings-endpoint");
  writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`);
  renameSync(temporary, join(dir, "endpoint.json"));
}

test("the wait ends with the endpoint of the process that replaced the previous one", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  publish(dir, { pid: 100, address: "/tmp/old.sock" });
  const waiting = untilEndpoint(dir, 100, 5000);
  // The previous process removes its endpoint.json when it ends, and the new process writes its own.
  rmSync(join(dir, "endpoint.json"));
  publish(dir, { pid: 200, address: "/tmp/new.sock" });
  assert.deepEqual(await waiting, { pid: 200, address: "/tmp/new.sock" });
});

test("the wait reads an endpoint that the new process wrote before the watch started", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  publish(dir, { pid: 200, address: "/tmp/new.sock" });
  assert.deepEqual(await untilEndpoint(dir, 100, 5000), { pid: 200, address: "/tmp/new.sock" });
});

test("the wait rejects at its deadline with the content of endpoint.json", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  publish(dir, { pid: 100, address: "/tmp/old.sock" });
  await assert.rejects(untilEndpoint(dir, 100, 300),
    new RegExp(`^Error: ${join(dir, "endpoint.json")} named no process other than 100 within 300 ms; it holds \\{"pid":100,"address":"/tmp/old.sock"\\}$`));
});

test("the wait rejects an endpoint.json that is not JSON", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const waiting = untilEndpoint(dir, 100, 5000);
  const temporary = join(dir, ".settings-endpoint");
  writeFileSync(temporary, "{");
  renameSync(temporary, join(dir, "endpoint.json"));
  await assert.rejects(waiting, new RegExp(`^SyntaxError: ${join(dir, "endpoint.json")} is not JSON: `));
});
