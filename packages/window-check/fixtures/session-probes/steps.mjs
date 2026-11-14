// A check that waits on a status that never changes and ends at its own test time limit, run by test/session-steps.test.mjs in a run of
// its own. The host side is the endpoint case window-check-steps-never-satisfied.
import test from "node:test";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { Session } from "../../app.mjs";

test("probe waits past its limit", { timeout: 300 }, async (t) => {
  const server = await startCasePlayer("window-check-steps-never-satisfied");
  const client = await connect({ configDir: server.configDir });
  t.after(async () => {
    client.close();
    await server.close();
  });
  const session = new Session({ name: "probe", configDir: server.configDir }, client);
  await session.get("core.project");
  await session.until("probe.document", () => false, "the probe document did not start");
});
