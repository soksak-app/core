import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CORE_CATALOG, coreCatalog, recordCatalog } from "../catalog.mjs";

const SPEC_CATALOG = new URL("../../../docs/spec/events.json", import.meta.url);

test("the core catalog that the package ships is docs/spec/events.json", () => {
  assert.equal(readFileSync(CORE_CATALOG, "utf8"), readFileSync(SPEC_CATALOG, "utf8"),
    "core-events.json of @soksak/window-check differs from docs/spec/events.json; copy docs/spec/events.json over it");
  assert.deepEqual(coreCatalog(), JSON.parse(readFileSync(SPEC_CATALOG, "utf8")));
});

const PLUGIN_PATH = "store/probe/1.0.0";
const SIDECAR_PATH = "store/alpha/1.0.0/platform";
const fields = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { kind: { type: "string" } }, required: ["kind"] };

/** A configuration folder that installed the plugin `probe` and the sidecar `alpha`, each with an event catalog. */
function configuration(t) {
  const root = mkdtempSync(join(tmpdir(), "window-check-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, PLUGIN_PATH), { recursive: true });
  mkdirSync(join(root, SIDECAR_PATH), { recursive: true });
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "plugins", "installed.json"), JSON.stringify({
    format: 3,
    plugins: { probe: { version: "1.0.0", path: PLUGIN_PATH, enabled: true } },
    sidecars: { alpha: { version: "1.0.0", path: SIDECAR_PATH } },
  }));
  writeFileSync(join(root, PLUGIN_PATH, "plugin.json"), JSON.stringify({ id: "probe", name: "Probe", description: "Probe plugin", sections: [], events: "events.json" }));
  writeFileSync(join(root, PLUGIN_PATH, "events.json"), JSON.stringify({ schema: 3, layers: ["plugin"],
    events: { "plugin.probe.frame": { layer: "plugin", class: "input", level: "info", fields } } }));
  writeFileSync(join(root, SIDECAR_PATH, "sidecar.json"), JSON.stringify({ displayName: "soksak://sidecar/alpha", executable: "bin/alpha", protocol: 1, events: "events.json" }));
  writeFileSync(join(root, SIDECAR_PATH, "events.json"), JSON.stringify({ schema: 3, sidecar: "alpha", layers: ["sidecar"],
    events: { "sidecar.alpha.ready": { layer: "sidecar", class: "lifecycle", level: "info", fields } } }));
  return root;
}

test("the record catalog joins the core catalog with the catalogs of the plugins and sidecars installed in a configuration folder", (t) => {
  const core = coreCatalog();
  const catalog = recordCatalog(configuration(t));
  for (const name of Object.keys(core.events)) assert.ok(catalog.events[name], `the record catalog lacks the core event ${name}`);
  assert.equal(catalog.events["plugin.probe.frame"].layer, "plugin");
  assert.equal(catalog.events["sidecar.alpha.ready"].layer, "sidecar");
  assert.ok(catalog.layers.includes("plugin") && catalog.layers.includes("sidecar"));
});

test("the record catalog of a configuration folder that installed nothing is the core catalog", (t) => {
  const root = mkdtempSync(join(tmpdir(), "window-check-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(Object.keys(recordCatalog(root).events).sort(), Object.keys(coreCatalog().events).sort());
});

test("an installed plugin whose manifest names another id is an error that names its plugin.json", (t) => {
  const root = configuration(t);
  writeFileSync(join(root, PLUGIN_PATH, "plugin.json"), JSON.stringify({ id: "other", name: "Probe", description: "Probe plugin", sections: [], events: "events.json" }));
  assert.throws(() => recordCatalog(root), /plugin\.json: plugin id other does not match installed plugin probe/);
});
