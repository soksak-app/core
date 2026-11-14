// A passing check whose cleanup steps fail in the first and the third step, run by test/session-cleanup.test.mjs in a run of its
// own. It prints the order in which the steps ran.
import test from "node:test";
import { finishSession } from "../../app.mjs";
import { probeSession } from "./session.mjs";

test("probe body passes", async (t) => {
  const { session, close } = await probeSession(t);
  const ran = [];
  // A cleanup registered before the steps runs after them, in the reverse order of registration.
  session.cleanup(async () => { ran.push("earlier"); });
  session.cleanupSteps(
    async () => { ran.push("first"); throw new Error("probe first step failed"); },
    async () => { ran.push("second"); },
    async () => { ran.push("third"); throw new Error("probe third step failed"); });
  t.after(async () => {
    try {
      await finishSession(t, session, close);
    } finally {
      process.stdout.write("steps ran: " + ran.join(" ") + "\n");
    }
  });
});
