// Checks that the terminal surface reattaches without an app restart when the persistent terminal sidecar service dies (V5-106).
// Kills the service and measures that a new session opens and the input arrives on the screen.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

// Reads the endpoint that one persistent service directory of the configuration directory holds.
// The terminal is the only persistent sidecar, so there is also one entry under services.
function serviceEndpoint(configDir) {
  const services = readdirSync(join(configDir, "services"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.equal(services.length, 1, `expected one persistent service directory, found ${services.length}`);
  return {
    name: services[0].name,
    endpoint: JSON.parse(readFileSync(join(configDir, "services", services[0].name, "endpoint.json"), "utf8")),
  };
}

test("a killed terminal sidecar recovers without an application restart", async (t) => {
  for (const app of Object.values(APPS)) {
    const session = await open(t, app);
    if (!session) continue;
    await fresh(session);
    const [terminal] = await ensureTerminals(session, 1);
    const surface = terminal.surface;

    // Before the kill, the session is alive and the input arrives on the screen.
    const before = await session.get("terminal.session", surface);
    assert.ok(before.sessionId, "the terminal session did not open before the kill");
    await session.run("terminal.input", { bytes: "echo V5106-BEFORE\r" }, surface);
    await readScreenUntil(session, surface,
      (lines) => lines.some((line) => line.includes("V5106-BEFORE")),
      "input before the kill did not reach the session");

    // Kills the persistent service. The session and the picture state disappear together with the service.
    const { endpoint: killed } = serviceEndpoint(app.configDir);
    assert.ok(Number.isInteger(killed.pid) && killed.pid > 0, "the service endpoint has no pid");
    process.kill(killed.pid, "SIGKILL");

    // Recovery: the surface attaches to the reopened session. A sessionId different from that of the dead session must arrive.
    await session.until("terminal.session",
      (value) => typeof value.sessionId === "string" && value.sessionId !== "" && value.sessionId !== before.sessionId,
      "the terminal did not reopen a session after the sidecar died", { surface });
    const after = await session.get("terminal.session", surface);
    assert.equal(after.error, undefined, `the reopened session kept an error: ${after.error}`);

    // After the recovery, the input reaches the new session.
    await session.run("terminal.input", { bytes: "echo V5106-AFTER\r" }, surface);
    await readScreenUntil(session, surface,
      (lines) => lines.some((line) => line.includes("V5106-AFTER")),
      "input after the recovery did not reach the reopened session");

    // The service is respawned and runs with a new pid.
    const { endpoint: respawned } = serviceEndpoint(app.configDir);
    assert.notEqual(respawned.pid, killed.pid, "the service was not respawned after the kill");
  }
});
