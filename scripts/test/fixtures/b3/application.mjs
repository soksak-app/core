#!/usr/bin/env node
// A fixture application of the B3 run tests, started as `application.mjs --config-dir DIR`. It plays the endpoint case that
// B3_FIXTURE_CASE names (docs/spec/cases/endpoint, `b3-run` without it), writes DIR/endpoint.json, and exits when the case has been
// played with status 0. At the first failure of the case it writes the failure on stderr and exits with status 1. The window that the case reports has the refresh
// rate and the backing scale that B3_FIXTURE_REFRESH_RATE and B3_FIXTURE_BACKING_SCALE name. B3_FIXTURE_EXIT=1 makes it exit with
// status 3 before it writes the endpoint.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startCasePlayer } from "@soksak/client/testing";

const { values } = parseArgs({ strict: true, options: { "config-dir": { type: "string" } } });
if (process.env.B3_FIXTURE_EXIT === "1") process.exit(3);
const player = await startCasePlayer(process.env.B3_FIXTURE_CASE ?? "b3-run", {
  values: { scale: Number(process.env.B3_FIXTURE_BACKING_SCALE), "refresh-rate": Number(process.env.B3_FIXTURE_REFRESH_RATE) },
});
copyFileSync(join(player.configDir, "endpoint.json"), join(values["config-dir"], "endpoint.json"));
// A frame of the client that differs from the case ends the application at once, so no fixture process waits for a step that will not come.
player.events.once("failure", (failure) => {
  process.stderr.write(`${failure}\n`);
  process.exit(1);
});
await player.played;
try {
  await player.close();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
process.exit(0);
