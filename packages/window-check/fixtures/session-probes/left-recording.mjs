// A passing check that leaves a recording folder the session does not track, run by test/session-cleanup.test.mjs in a run of its
// own. SESSION_PROBE is the JSON of { configDir }.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { finishSession, recordingFolders } from "../../app.mjs";
import { probeSession } from "./session.mjs";

const { configDir } = JSON.parse(process.env.SESSION_PROBE);

test("probe body passes", async (t) => {
  const { session, close } = await probeSession(t, { configDir, eventStart: {} });
  session.recordingsBefore = recordingFolders(configDir);
  mkdirSync(join(configDir, "logs", "captures", "left"));
  writeFileSync(join(configDir, "logs", "captures", "left", "frame-0001.bgra"), "evidence");
  t.after(() => finishSession(t, session, close));
});
