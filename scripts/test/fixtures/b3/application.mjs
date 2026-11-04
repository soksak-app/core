#!/usr/bin/env node
// A fixture application of the B3 run tests, started as `application.mjs --config-dir DIR`. It serves an endpoint, writes DIR/endpoint.json,
// lists one window, answers `status.get` of `host.window` with the refresh rate and the backing scale that B3_FIXTURE_REFRESH_RATE and
// B3_FIXTURE_BACKING_SCALE name, and exits after it answers `host.quit`. B3_FIXTURE_EXIT=1 makes it exit with status 3 before it writes the endpoint.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startFakeEndpoint } from "@soksak/client/testing";

const { values } = parseArgs({ strict: true, options: { "config-dir": { type: "string" } } });
if (process.env.B3_FIXTURE_EXIT === "1") process.exit(3);
const fake = await startFakeEndpoint({
  "windows.list": () => [{ window: "main", title: "fixture", project: null, key: true, ready: true }],
  "status.get": (params) => {
    if (params.name !== "host.window") throw Object.assign(new Error(`unknown status ${params.name}`), { code: 1004 });
    return { scale: Number(process.env.B3_FIXTURE_BACKING_SCALE), refreshRate: Number(process.env.B3_FIXTURE_REFRESH_RATE) };
  },
  "command.run": (params) => {
    if (params.name !== "host.quit") throw Object.assign(new Error(`unknown command ${params.name}`), { code: 1004 });
    setTimeout(() => fake.close().then(() => process.exit(0)), 50);
    return null;
  },
});
copyFileSync(join(fake.configDir, "endpoint.json"), join(values["config-dir"], "endpoint.json"));
