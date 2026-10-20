import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateExposureFile } from "@soksak/plugin-api";

const PLUGIN_STATUSES = ["core.plugin.open-calls", "core.plugin.losses", "core.plugin.views"];

const declaredExposure = () => validateExposureFile(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

test("the plugin process statuses are declared by the core exposure file", () => {
  const { status } = declaredExposure().exposes;
  const names = status.map((entry) => entry.name);
  for (const name of PLUGIN_STATUSES) assert.ok(names.includes(name), `${name} is not declared in exposure.json`);
});

test("each plugin process status is registered and publishes its empty initial value", async () => {
  const { createRegistry } = await import("../exposure.js");
  const { losses, openCalls, views } = await import("../plugin-processes.js");
  const readers = { "core.plugin.open-calls": openCalls, "core.plugin.losses": losses, "core.plugin.views": views };
  const made = createRegistry();
  made.declare("core", declaredExposure().exposes);
  for (const name of PLUGIN_STATUSES) made.status(name, readers[name], () => () => {});
  for (const name of PLUGIN_STATUSES) {
    const empty = await made.handle({ method: "status.get", params: { name } });
    assert.deepEqual(empty, { result: [] }, `${name} initial value`);
  }
});
