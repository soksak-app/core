// A passing check over an event log that the test wrote, run by test/session-cleanup.test.mjs in a run of its own. SESSION_PROBE
// is the JSON of { configDir, started, expected }: the configuration folder, the bytes of host-1-1.jsonl before the check started,
// and the sources of the patterns of the errors that the check declares.
import { statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { finishSession } from "../../app.mjs";
import { probeSession } from "./session.mjs";

const { configDir, started, expected } = JSON.parse(process.env.SESSION_PROBE);

test("probe body passes", async (t) => {
  const inode = String(statSync(join(configDir, "logs", "host-1-1.jsonl"), { bigint: true }).ino);
  const { session, close } = await probeSession(t, { configDir, eventStart: { "host-1-1.jsonl": { offset: started, inode } } });
  for (const source of expected) session.expectedErrors.push(new RegExp(source));
  t.after(() => finishSession(t, session, close));
});
