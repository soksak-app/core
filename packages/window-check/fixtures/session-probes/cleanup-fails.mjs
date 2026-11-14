// A check whose body and whose first cleanup both fail, run by test/session-cleanup.test.mjs in a run of its own.
import test from "node:test";
import { finishSession } from "../../app.mjs";
import { probeSession } from "./session.mjs";

test("probe body fails", async (t) => {
  const { session, close } = await probeSession(t);
  session.cleanups.push(async () => { throw new Error("probe press stayed open"); }, async () => {});
  t.after(() => finishSession(t, session, close));
  throw new Error("probe body failed");
});
