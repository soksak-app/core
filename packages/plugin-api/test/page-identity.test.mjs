// Checks that a page finds its plugin from its location: a sok page from its host, a staged page from its path, and any other
// location is refused with an error that names the location.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { pagePlugin } from "../index.js";

const locationOf = (url) => new JSDOM("", { url }).window.location;

test("a sok page belongs to the plugin named by its host and reads the manifest from its origin", () => {
  assert.deepEqual(pagePlugin(locationOf("sok://probe/ui/index.html")), { name: "probe", manifest: "/plugin.json" });
  assert.deepEqual(pagePlugin(locationOf("sok://plugin-probe/")), { name: "plugin-probe", manifest: "/plugin.json" });
});

test("a staged page of the main origin belongs to the module named by its path", () => {
  assert.deepEqual(pagePlugin(locationOf("https://example.test/modules/plugin-probe/ui/index.html")),
    { name: "plugin-probe", manifest: "/modules/plugin-probe/plugin.json" });
  assert.deepEqual(pagePlugin(locationOf("https://example.test/modules/@scope/plugin-probe/ui/probe.html")),
    { name: "@scope/plugin-probe", manifest: "/modules/@scope/plugin-probe/plugin.json" });
});

test("a page that is neither a sok page nor a staged page has no plugin", () => {
  assert.equal(pagePlugin(locationOf("https://example.test/overlay.html")), null);
});

test("a sok page whose host is not a plugin id is refused with the location", () => {
  assert.throws(() => pagePlugin(locationOf("sok://Probe_1/ui/index.html")), /sok:\/\/Probe_1\/ui\/index\.html: host Probe_1/);
});

test("a sok page of the core root is refused, because core is not a plugin id", () => {
  assert.throws(() => pagePlugin(locationOf("sok://core/ui/index.html")), /sok:\/\/core\/ui\/index\.html.*core/);
});
