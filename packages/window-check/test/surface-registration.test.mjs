// A view surface reaches the phase `ready` when it declares its composition and registers its exposure after that
// (docs/spec/native-surfaces.md), so a wait on a status of a surface starts when the surface has registered that status.
// The case holds the requests in their order: the player fails a watch of the status of the surface before core.surfaces lists it.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../app.mjs";
import { playSession } from "../fixtures/endpoint-player.mjs";

test("a wait on a status of a surface watches the status after the surface has registered it", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-surface-status", "wailsv3");
  assert.deepEqual(await session.until("probe.document", (value) => value.path === "note.txt", "no document", { surface: "tab-1" }),
    { path: "note.txt" });
});

test("a wait without a surface watches the status at once", { timeout: 5000 }, async (t) => {
  const { session } = await playSession(t, Session, "window-check-page-status", "wailsv3");
  await session.until("core.project", (value) => value.id === "p", "no project");
});
