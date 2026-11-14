import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";
import { temporaryProject, ownProjectWindow } from "../project-resource.mjs";

// The case holds the requests of the cleanups in their order: the close of the child window, the read of the projects, the detach
// of the project that the application lists for the folder, and the flush. The folder that the test creates is the root that the
// application lists.
for (const bodyFails of [false, true]) test(`temporary project releases its live window before removing files after ${bodyFails ? "failure" : "success"}`, { timeout: 5000 }, async (t) => {
  const values = {};
  const { session, player } = await playSession(t, Session, "window-check-project-resource", "resource-owner", { values });
  // The folder survives every request of the cleanups: the project closes and flushes before its files are removed.
  const folderPresent = [];
  let folder;
  player.events.on("request", () => folderPresent.push(existsSync(folder)));
  const original = new Error("post-open input failed");
  try {
    folder = temporaryProject(session, "soksak-project-owner-");
    values.root = folder;
    const close = ownProjectWindow(session, session.on("project-window"));
    if (bodyFails) throw original;
    await close();
  } catch (error) {
    assert.equal(error, original);
  } finally {
    // This is the session's documented LIFO ownership contract.
    for (const cleanup of session.cleanups.reverse()) await cleanup();
  }
  assert.equal(folderPresent.length, 4);
  assert.deepEqual(folderPresent, [true, true, true, true]);
  assert.equal(existsSync(folder), false);
});
