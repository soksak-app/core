// Checks that a page finds its plugin and the plugin id from its location: a sok page from its host, a staged page from its
// path. A sok page takes the id of its host and its plugin.json must carry that id; a staged page takes the id of the installed
// plugin whose package is its module name. Any other location has no plugin, and an invalid location is refused with an error
// that names the location.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { pageIdentity, pagePlugin } from "../index.js";

const locationOf = (url) => new JSDOM("", { url }).window.location;
const manifest = (id) => ({ id, name: "Probe", description: "검사용.", host: { page: "ui/host.html" },
  exposes: { status: [{ name: `${id}.list`, description: "검사용.", schema: { type: "object" } }] }, sections: [{ id: `${id}.list`, name: "List", status: `${id}.list` }] });
// The host reads a path of the page origin; a path without a file fails the way the fetch of the page does.
const reader = (files) => async (path) => {
  if (!(path in files)) throw new Error(`failed to load ${path}: 404`);
  return files[path];
};
// probe-id is the plugin id, probe-name is its package, and the staged module of the package is under modules/probe-name.
const installed = { plugins: [{ id: "probe-id", package: "probe-name", version: "0.1.0", manifest: manifest("probe-id") }] };

test("pagePlugin of a sok page is its host and the manifest on its own origin", () => {
  assert.deepEqual(pagePlugin(locationOf("sok://probe/ui/index.html")), { host: "probe", manifest: "/plugin.json" });
  assert.deepEqual(pagePlugin(locationOf("sok://plugin-probe/")), { host: "plugin-probe", manifest: "/plugin.json" });
});

test("pagePlugin of a staged page is its package and the manifest of its module", () => {
  assert.deepEqual(pagePlugin(locationOf("https://example.test/modules/plugin-probe/ui/index.html")),
    { package: "plugin-probe", manifest: "/modules/plugin-probe/plugin.json" });
  assert.deepEqual(pagePlugin(locationOf("https://example.test/modules/@scope/plugin-probe/ui/probe.html")),
    { package: "@scope/plugin-probe", manifest: "/modules/@scope/plugin-probe/plugin.json" });
});

test("a page that is neither a sok page nor a staged page has no plugin", async () => {
  assert.equal(pagePlugin(locationOf("https://example.test/overlay.html")), null);
  assert.equal(await pageIdentity(locationOf("https://example.test/overlay.html"), reader({})), null);
});

test("a sok page whose host is not a plugin id is refused with the location", () => {
  assert.throws(() => pagePlugin(locationOf("sok://Probe_1/ui/index.html")), /sok:\/\/Probe_1\/ui\/index\.html: host Probe_1/);
});

test("a sok page of the core root is refused, because core is not a plugin id", () => {
  assert.throws(() => pagePlugin(locationOf("sok://core/ui/index.html")), /sok:\/\/core\/ui\/index\.html.*core/);
});

test("a sok page has the id of its host when its plugin.json carries that id", async () => {
  const identity = await pageIdentity(locationOf("sok://probe-id/ui/index.html"), reader({ "/plugin.json": manifest("probe-id") }));
  assert.equal(identity.id, "probe-id");
  assert.deepEqual(identity.manifest, manifest("probe-id"));
});

test("a sok page whose plugin.json id differs from its host fails with both ids", async () => {
  await assert.rejects(pageIdentity(locationOf("sok://probe-id/ui/index.html"), reader({ "/plugin.json": manifest("probe-name") })),
    /^Error: plugin\.json id probe-name differs from the page plugin probe-id$/);
});

test("a staged page has the id of the installed plugin whose package is its module name", async () => {
  const identity = await pageIdentity(locationOf("https://example.test/modules/probe-name/ui/index.html"), reader({
    "/installed-plugins.json": installed,
    "/modules/probe-name/plugin.json": manifest("probe-id"),
  }));
  assert.equal(identity.id, "probe-id");
});

test("a staged page whose module has no installed entry fails with the package", async () => {
  await assert.rejects(pageIdentity(locationOf("https://example.test/modules/other-name/ui/index.html"), reader({
    "/installed-plugins.json": installed,
    "/modules/other-name/plugin.json": manifest("other-id"),
  })), /^Error: other-name: no installed plugin has this package in installed-plugins\.json$/);
});

test("a staged page whose plugin.json id differs from its installed entry fails with both ids", async () => {
  await assert.rejects(pageIdentity(locationOf("https://example.test/modules/probe-name/ui/index.html"), reader({
    "/installed-plugins.json": installed,
    "/modules/probe-name/plugin.json": manifest("probe-other"),
  })), /^Error: plugin\.json id probe-other differs from the installed plugin probe-id$/);
});

test("a host that cannot read the installed plugins fails with the host error", async () => {
  await assert.rejects(pageIdentity(locationOf("https://example.test/modules/probe-name/ui/index.html"), reader({
    "/installed-plugins.json": { error: "plugins/installed.json: format must be 2" },
    "/modules/probe-name/plugin.json": manifest("probe-id"),
  })), /installed plugins: plugins\/installed\.json: format must be 2/);
});
