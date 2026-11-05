#!/usr/bin/env node
// A fixture application of the B3 run tests, started as `application.mjs --config-dir DIR`. It serves an endpoint, writes DIR/endpoint.json,
// lists one window, answers `status.get` of `host.window` with the refresh rate and the backing scale that B3_FIXTURE_REFRESH_RATE and
// B3_FIXTURE_BACKING_SCALE name, reports its window occluded until a move of `input.pointer` with `activate` true, and exits after it answers `host.quit`.
// B3_FIXTURE_ACTIVATION_FAILS=1 refuses that move, and B3_FIXTURE_COVERED=1 keeps the window occluded after it. B3_FIXTURE_EXIT=1 makes it exit with status 3 before it writes the endpoint.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startFakeEndpoint } from "@soksak/client/testing";

const { values } = parseArgs({ strict: true, options: { "config-dir": { type: "string" } } });
if (process.env.B3_FIXTURE_EXIT === "1") process.exit(3);
let activated = false;
const fake = await startFakeEndpoint({
  "windows.list": () => [{ window: "main", title: "fixture", project: null, key: true, ready: true }],
  "status.get": (params) => {
    if (params.name !== "host.window") throw Object.assign(new Error(`unknown status ${params.name}`), { code: 1004 });
    return {
      scale: Number(process.env.B3_FIXTURE_BACKING_SCALE), refreshRate: Number(process.env.B3_FIXTURE_REFRESH_RATE),
      content: { width: 1200, height: 760 }, occluded: !activated || process.env.B3_FIXTURE_COVERED === "1",
    };
  },
  "input.pointer": (params) => {
    if (process.env.B3_FIXTURE_ACTIVATION_FAILS === "1") throw Object.assign(new Error("the window is not active"), { code: 1006 });
    if (params.phase === "move" && params.activate === true) activated = true;
    return null;
  },
  "command.run": (params) => {
    if (params.name !== "host.quit") throw Object.assign(new Error(`unknown command ${params.name}`), { code: 1004 });
    setTimeout(() => fake.close().then(() => process.exit(0)), 50);
    return null;
  },
});
copyFileSync(join(fake.configDir, "endpoint.json"), join(values["config-dir"], "endpoint.json"));
