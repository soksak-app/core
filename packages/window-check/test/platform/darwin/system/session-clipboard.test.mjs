// Clipboard ownership is explicit; preparation failures release resources before open rejects. The checks run on a pasteboard of
// macOS that has a name of its own and that the file releases when it ends, so they never read or write the general pasteboard of
// the person. These tests read and write the pasteboard of the system, so they run only on macOS.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { playApplication } from "../../../../fixtures/endpoint-player.mjs";
import { pasteboardDifference, pasteboardFault, readPasteboard, releasePasteboard, writePasteboard } from "../../../../pasteboard.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-session-clipboard-")));
process.env.TMPDIR = root;
delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
const { open, acquireWindowCheckSlot } = await import("../../../../app.mjs");

const text = (value) => ({ "public.utf8-plain-text": Buffer.from(value).toString("base64") });
const board = `app.soksak.window-check.test-${randomUUID()}`;
// The operations that the session ran on the pasteboard, in their order; `injected` is the error that the next operation throws.
const calls = [];
let injected = null;
let observing = true;
pasteboardFault.before = (operation) => {
  if (!observing) return;
  calls.push(operation);
  if (injected?.operation === operation) throw injected.error;
};
test.after(() => {
  pasteboardFault.before = null;
  releasePasteboard(board);
  rmSync(root, { recursive: true, force: true });
});

/** Runs `action` without recording its pasteboard operations: the operations of the test are not the operations of the session. */
function unobserved(action) {
  observing = false;
  try { return action(); } finally { observing = true; }
}
/** Writes the pasteboard as the person's clipboard before a check. */
const prepare = (value) => unobserved(() => writePasteboard([text(value)], board));
const current = () => unobserved(() => readPasteboard(board).items);

function context(name) {
  const afters = [];
  return { name, passed: true, diagnostic() {}, after(fn) { afters.push(fn); },
    async finish() { for (const fn of afters) await fn(); } };
}
/** The application `application` whose endpoint names `endpointApplication` and the player of its endpoint. */
async function setup(t, application, endpointApplication = application) {
  const player = await playApplication(t, "window-check-open-idle", endpointApplication);
  return { player, app: { name: application, binary: process.execPath, configDir: player.configDir } };
}

/** Resolves when the connection of the session to the player has ended: a session that opened and was rejected closed it. */
async function closed(player) {
  await Promise.all([...player.connections].map((socket) => once(socket, "close")));
  assert.equal(player.connections.size, 0, "the connection of the session stayed open");
}

test("an explicitly owning session restores clipboard after test cleanup", { timeout: 20000 }, async (t) => {
  prepare("before");
  const before = current();
  calls.length = 0;
  const check = context("owner");
  const { app } = await setup(t, "tauriv2");
  const s = await open(check, app, { clipboard: true, pasteboard: board });
  s.cleanup(() => { unobserved(() => writePasteboard([{ "public.png": Buffer.from("changed").toString("base64") }], board)); });
  check.passed = false; // Restoration is required even when the test body failed.
  await check.finish();
  assert.equal(pasteboardDifference(before, current()), null);
  assert.deepEqual(calls, ["read", "write", "read"]);
});

for (const failRestore of [false, true]) {
  test(`clipboard owner restores on endpoint preparation failure (restore error: ${failRestore})`, { timeout: 20000 }, async (t) => {
    const check = context("owner endpoint fails");
    prepare("before");
    const before = current();
    calls.length = 0;
    const { app, player } = await setup(t, "tauriv2", "other");
    injected = failRestore ? { operation: "write", error: new Error("clipboard restore failed") } : null;
    try {
      await assert.rejects(open(check, app, { clipboard: true, pasteboard: board }), (error) => {
        if (failRestore) {
          assert.ok(error instanceof AggregateError);
          assert.match(error.errors[0].message, /belongs to other/);
          assert.match(error.errors[1].message, /clipboard restore failed/);
        } else assert.match(error.message, /belongs to other/);
        return true;
      });
      await closed(player);
      const release = await acquireWindowCheckSlot("tauriv2");
      release();
      await check.finish();
      assert.equal(pasteboardDifference(before, current()), null);
      assert.deepEqual(calls, failRestore ? ["read", "write"] : ["read", "write", "read"]);
    } finally { injected = null; }
  });
}
