// F292-9-4: the workbench sends the transcript lines as the record workbench.record.info, so a transcript under a log policy that does not
// store that record is refused at once with an error that names the record and the policy, instead of a wait that ends only at
// its deadline with no line.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../app.mjs";
import { playClient } from "../fixtures/endpoint-player.mjs";

const CATALOG = { events: {
  "workbench.record.<level>": { layer: "workbench", class: "lifecycle", level: ["error", "info"] },
} };

/**
 * A session of a configuration folder whose policy file holds `classes`, on the case `name` (window-check-open-idle for a refused
 * transcript, which sends no request, and window-check-transcript for one that turns the transcript on and off), and the player.
 */
async function session(t, name, classes) {
  const { player, client } = await playClient(t, name, "probe");
  const dir = player.configDir;
  writeFileSync(join(dir, "log-policy.json"), JSON.stringify({ schema: 1, classes }));
  return { s: new Session({ name: "probe", configDir: dir }, client), dir };
}

test("a transcript under a policy that does not store workbench.record.info is refused at once", async (t) => {
  // The case window-check-open-idle holds no request: a request of the refused transcript fails the player.
  const { s, dir } = await session(t, "window-check-open-idle", { lifecycle: "error", input: "error", call: "debug", io: "error", frame: "error" });
  await assert.rejects(s.transcript(CATALOG), {
    message: "the check reads workbench.record.info (class lifecycle, level info), which the log policy " +
      `{"lifecycle":"error","input":"error","call":"debug","io":"error","frame":"error"} of ${join(dir, "log-policy.json")} does not store`,
  });
});

test("a transcript under a policy that stores workbench.record.info turns the transcript of the workbench on", async (t) => {
  const { s } = await session(t, "window-check-transcript", { lifecycle: "info", input: "error", call: "debug", io: "error", frame: "error" });
  const transcript = await s.transcript(CATALOG);
  assert.deepEqual(await transcript.stop(), []);
});

test("a transcript without the catalog of its record is refused", async (t) => {
  const { s } = await session(t, "window-check-open-idle", { lifecycle: "info", input: "error", call: "error", io: "error", frame: "error" });
  await assert.rejects(s.transcript(),
    { message: "transcript: give the catalog that declares workbench.record.info, the record of the transcript lines" });
});
