// A failing check that left a recording and a capture folder of its own, run by test/session-cleanup.test.mjs in a run of its own.
// SESSION_PROBE is the JSON of { configDir }. The host side of the recording is the endpoint case window-check-capture-left-open.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { Session, finishSession, recordingFolders } from "../../app.mjs";

const { configDir } = JSON.parse(process.env.SESSION_PROBE);

test("probe body fails", async (t) => {
  const captures = join(configDir, "logs", "captures");
  mkdirSync(captures, { recursive: true });
  const frames = join(captures, "capture-1");
  const server = await startCasePlayer("window-check-capture-left-open", { values: { frames } });
  const client = await connect({ configDir: server.configDir });
  const session = new Session({ name: "probe", configDir }, client);
  session.eventStart = {};
  session.expectedErrors = [];
  session.recordingsBefore = recordingFolders(configDir);
  // The host creates the folder of the recording when the recording starts.
  mkdirSync(frames);
  const recording = await session.record();
  writeFileSync(join(recording.frames, "frame-0001.bgra"), "capture evidence");
  mkdirSync(join(captures, "failed"), { recursive: true });
  writeFileSync(join(captures, "failed", "frame-0001.bgra"), "capture evidence");
  t.after(async () => {
    try {
      await finishSession(t, session, () => {});
    } finally {
      client.close();
      await server.close();
    }
  });
  throw new Error("probe body failed");
});
