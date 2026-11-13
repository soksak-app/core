// Checks that a surface reattaches without an app restart when its persistent sidecar service dies (V5-106). The vehicle is the raster
// probe and its persistent fixture sidecar service: the check kills the service and measures that a new session opens and that a request
// of the surface reaches the new session and changes its presented frames.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { ensureRasters, presentedFrame, reopenedSession } from "./raster-probe.mjs";

// Reads the endpoint that one persistent service directory of the configuration directory holds.
// The raster probe sidecar is the only persistent sidecar of the fixtures, so there is also one entry under services.
function serviceEndpoint(configDir) {
  const services = readdirSync(join(configDir, "services"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  assert.equal(services.length, 1, `expected one persistent service directory, found ${services.length}`);
  return {
    name: services[0].name,
    endpoint: JSON.parse(readFileSync(join(configDir, "services", services[0].name, "endpoint.json"), "utf8")),
  };
}

// Each application has its own test and time limit, so a recovery that stops in one application ends that test only.
for (const app of Object.values(APPS)) {
  test(`${app.name}: a killed persistent sidecar recovers without an application restart`, { timeout: 120000 }, async (t) => {
    const session = await open(t, app);
    if (!session) return;
    await fresh(session);
    const [raster] = await ensureRasters(session, 1);
    const surface = raster.surface;

    // Before the kill, the session is alive and a request of the surface reaches it and changes the presented frame.
    const before = await session.get("rasterprobe.session", surface);
    assert.ok(before.session, "the raster probe session did not open before the kill");
    await session.run("rasterprobe.rows", { count: 2 }, surface);
    await presentedFrame(session, surface, (frame) => frame.rows === 2, "a frame with 2 row bands before the kill");

    // Kills the persistent service. The session and the picture state disappear together with the service.
    const { endpoint: killed } = serviceEndpoint(app.configDir);
    assert.ok(Number.isInteger(killed.pid) && killed.pid > 0, "the service endpoint has no pid");
    // The host logs the lost connection once when it restarts the service, with how the connection ended and the number of
    // requests that waited for it (docs/spec/diagnostics.md).
    session.expectError(/^error host sidecar @sok-check\/sidecar-rasterprobe: connection lost; restarted \(end: .+, waiting: \d+\)$/);
    // A frame that the service sent before it died names an IOSurface that ended with the service, so its presentation fails
    // with notFound in the host, the native region, the view and the status of the surface; a line that the host writes to
    // the closed connection fails with a broken pipe. Both happen only when the kill meets a frame or a write in flight.
    session.expectError(new RegExp(`^error host image present: surface=${surface} name=raster .* reason=notFound`));
    session.expectError(/^error native image region: notFound /);
    session.expectError(new RegExp(`^error workbench surface ${surface} rasterprobe: image raster: .*notFound`));
    session.expectError(new RegExp(`^error workbench surface status rasterprobe ${surface}: .*native image: notFound$`));
    session.expectError(/^error host sidecar @sok-check\/sidecar-rasterprobe: write: Broken pipe \(os error 32\)$/);
    assert.equal(before.service?.pid, killed.pid, "the session before the kill is not held by the service that the check kills");
    process.kill(killed.pid, "SIGKILL");

    // Recovery: the surface attaches to the session that the respawned service opens, which the new service holds.
    await session.until("rasterprobe.session", reopenedSession(before),
      "the raster probe did not reopen a session after the sidecar died", { surface });
    const after = await session.get("rasterprobe.session", surface);
    assert.equal(after.error, null, `the reopened session kept an error: ${after.error}`);

    // After the recovery, a request of the surface reaches the new session and changes its presented frame.
    await session.run("rasterprobe.rows", { count: 3 }, surface);
    await presentedFrame(session, surface, (frame) => frame.rows === 3, "a frame with 3 row bands from the reopened session");

    // The service is respawned and runs with a new pid.
    const { endpoint: respawned } = serviceEndpoint(app.configDir);
    assert.notEqual(respawned.pid, killed.pid, "the service was not respawned after the kill");
  });
}
