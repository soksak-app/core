// Clipboard ownership is explicit; preparation failures release resources before open rejects.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { mock } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-session-clipboard-")));
process.env.TMPDIR = root;
delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
const binary = join(root, "probe-binary");
writeFileSync(binary, "");
let snapshotError;
let wrongApplication = false;
let restoreError;
let board = [{ "public.utf8-plain-text": "YmVmb3Jl" }];
const calls = [];
const clients = [];
mock.module("../pasteboard.mjs", { exports: {
  readPasteboard() {
    calls.push("read");
    if (snapshotError) throw snapshotError;
    return { items: structuredClone(board), unreadable: board.map(() => []), changeCount: 1 };
  },
  writePasteboard(items) { calls.push("write"); if (restoreError) throw restoreError; board = structuredClone(items); return 1; },
  restorableItems(value) { return { items: value.items, skipped: [] }; },
  restoreFailure(saved, written, after) { return JSON.stringify(saved) === JSON.stringify(after.items) ? null : "changed"; },
} });
mock.module("../event-log.mjs", { exports: {
  readEventErrors: () => ({ errors: [] }), sessionEventBoot: () => 0, sessionEventStart: () => ({}),
} });
class EndpointError extends Error {}
mock.module("@soksak/client", { exports: {
  EndpointError,
  async connect({ configDir }) {
    const name = basename(configDir);
    const client = { closed: 0, endpoint: { pid: process.pid, application: wrongApplication ? "other" : name, executable: binary,
      started: new Date(Date.now() + 60_000).toISOString() },
    close() { this.closed++; }, request: async () => null };
    clients.push(client);
    return client;
  },
} });
const { open, acquireWindowCheckSlot } = await import("../app.mjs");
function context(name) {
  const afters = [];
  return { name, passed: true, diagnostic() {}, after(fn) { afters.push(fn); },
    async finish() { for (const fn of afters) await fn(); } };
}
const app = (name) => ({ name, binary, configDir: join(root, name) });
test.after(() => rmSync(root, { recursive: true, force: true }));

test("an unrelated session never reads or writes the clipboard", { timeout: 10000 }, async () => {
  calls.length = 0;
  const check = context("unrelated");
  try { await open(check, app("wailsv3")); } finally { await check.finish(); }
  assert.deepEqual(calls, []);
});

test("an explicitly owning session restores clipboard after test cleanup", { timeout: 10000 }, async () => {
  calls.length = 0;
  const before = structuredClone(board);
  const check = context("owner");
  const s = await open(check, app("tauriv2"), { clipboard: true });
  s.cleanup(() => { board = [{ "public.png": "Y2hhbmdlZA==" }]; });
  check.passed = false; // Restoration is required even when the test body failed.
  await check.finish();
  assert.deepEqual(board, before);
  assert.deepEqual(calls, ["read", "write", "read"]);
});

test("clipboard preparation failure immediately closes connection and releases slot", { timeout: 10000 }, async () => {
  const check = context("snapshot fails");
  snapshotError = new Error("snapshot preparation failed");
  try {
    await assert.rejects(open(check, app("mygo"), { clipboard: true }), /snapshot preparation failed/);
    assert.equal(clients.at(-1).closed, 1, "open must close before rejecting, without waiting for after hooks");
    const release = await acquireWindowCheckSlot("mygo");
    release();
    await check.finish();
    assert.equal(clients.at(-1).closed, 1, "after hooks must not close the failed preparation twice");
  } finally { snapshotError = undefined; }
});

test("endpoint preparation failure immediately releases resources without clipboard ownership", { timeout: 10000 }, async () => {
  const check = context("wrong endpoint");
  wrongApplication = true;
  try {
    await assert.rejects(open(check, app("wailsv3")), /belongs to other/);
    assert.equal(clients.at(-1).closed, 1, "endpoint validation failure must close before rejecting");
    const release = await acquireWindowCheckSlot("wailsv3");
    release();
    await check.finish();
    assert.equal(clients.at(-1).closed, 1);
  } finally { wrongApplication = false; }
});

for (const failRestore of [false, true]) {
  test(`clipboard owner restores on endpoint preparation failure (restore error: ${failRestore})`, { timeout: 10000 }, async () => {
    const check = context("owner endpoint fails");
    const before = structuredClone(board);
    calls.length = 0;
    wrongApplication = true;
    restoreError = failRestore ? new Error("clipboard restore failed") : undefined;
    try {
      await assert.rejects(open(check, app("tauriv2"), { clipboard: true }), (error) => {
        if (failRestore) {
          assert.ok(error instanceof AggregateError);
          assert.match(error.errors[0].message, /belongs to other/);
          assert.match(error.errors[1].message, /clipboard restore failed/);
        } else assert.match(error.message, /belongs to other/);
        return true;
      });
      assert.equal(clients.at(-1).closed, 1);
      const release = await acquireWindowCheckSlot("tauriv2");
      release();
      await check.finish();
      assert.equal(clients.at(-1).closed, 1);
      assert.deepEqual(board, before);
      assert.deepEqual(calls, failRestore ? ["read", "write"] : ["read", "write", "read"]);
    } finally { wrongApplication = false; restoreError = undefined; }
  });
}
