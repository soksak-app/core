// Clipboard ownership is explicit; preparation failures release resources before open rejects. The sessions of these checks never
// reach the pasteboard of the system: the fault point of the pasteboard operations fails each read before it runs, and the tests that
// read or write the pasteboard of macOS are in test/platform/darwin/system/session-clipboard.test.mjs.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { playApplication } from "../fixtures/endpoint-player.mjs";
import { pasteboardFault } from "../pasteboard.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-session-clipboard-")));
process.env.TMPDIR = root;
delete process.env.SOKSAK_APP;
delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
const { open, acquireWindowCheckSlot } = await import("../app.mjs");

const board = `app.soksak.window-check.test-${randomUUID()}`;
// The operations that the session ran on the pasteboard, in their order; `injected` is the error that the next operation throws.
const calls = [];
let injected = null;
pasteboardFault.before = (operation) => {
  calls.push(operation);
  if (injected?.operation === operation) throw injected.error;
};
test.after(() => {
  pasteboardFault.before = null;
  rmSync(root, { recursive: true, force: true });
});

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

test("an unrelated session never reads or writes the clipboard", { timeout: 20000 }, async (t) => {
  calls.length = 0;
  const check = context("unrelated");
  const { app } = await setup(t, "wailsv3");
  try { await open(check, app); } finally { await check.finish(); }
  assert.deepEqual(calls, []);
});

test("clipboard preparation failure immediately closes connection and releases slot", { timeout: 20000 }, async (t) => {
  const check = context("snapshot fails");
  const { app, player } = await setup(t, "mygo");
  injected = { operation: "read", error: new Error("snapshot preparation failed") };
  try {
    await assert.rejects(open(check, app, { clipboard: true, pasteboard: board }), /snapshot preparation failed/);
    await closed(player);
    const release = await acquireWindowCheckSlot("mygo");
    release();
    await check.finish();
  } finally { injected = null; }
});

test("endpoint preparation failure immediately releases resources without clipboard ownership", { timeout: 20000 }, async (t) => {
  const check = context("wrong endpoint");
  const { app, player } = await setup(t, "wailsv3", "other");
  await assert.rejects(open(check, app), /belongs to other/);
  await closed(player);
  const release = await acquireWindowCheckSlot("wailsv3");
  release();
  await check.finish();
});
