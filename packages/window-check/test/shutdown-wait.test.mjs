// The shutdown wait settles when the endpoint connection ends, which the kernel reports when the host process ends. The
// tests use a connection whose end the test controls, so the wait is judged by its event and not by an external process.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { untilShutdown } from "../shutdown-wait.mjs";

function folder(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "shutdown-wait-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A connection whose end the test emits. `ended` resolves with the closing cause, as the client of @soksak/client does.
function connection() {
  let end;
  const ended = new Promise((resolve) => (end = resolve));
  return { ended, close: (cause) => end(cause) };
}

test("a wait does not settle before the connection ends, and settles when it ends", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const file = join(dir, "endpoint.json");
  fs.writeFileSync(file, "{}\n");
  const client = connection();
  let settled = false;
  const waiting = untilShutdown(client, file, { from: Date.now(), limit: 5000 }).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the wait settled before the connection ended");
  fs.rmSync(file);
  client.close(new Error("endpoint connection closed"));
  const { closedMs } = await waiting;
  assert.equal(typeof closedMs, "number");
  assert.equal(fs.existsSync(file), false);
});

test("a wait rejects with the file name when the file exists at the end of the connection", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const file = join(dir, "endpoint.json");
  fs.writeFileSync(file, "{}\n");
  const client = connection();
  const waiting = untilShutdown(client, file, { from: Date.now(), limit: 5000 });
  client.close(new Error("endpoint connection closed"));
  await assert.rejects(waiting, /exists \d+ms after the request; the host removes it before its process ends$/);
});

test("a wait rejects with the limit when the connection does not end", { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const client = connection();
  await assert.rejects(untilShutdown(client, join(dir, "endpoint.json"), { from: Date.now(), limit: 100 }),
    /^Error: endpoint connection did not end within 100ms$/);
});
