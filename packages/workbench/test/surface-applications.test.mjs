// The connected applications that a surface reads through runtime.applications (docs/spec/plugins.md#connected-applications).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const shell = { version: "1.0.0", path: "/bin/sh", how: "located", method: "command" };
let applications = { shell };
// The plugin state of the host owns the record of plugins/applications.json; installed-plugins sets this reader in the app.
const { notifyConnectedApplications, setConnectedApplications } = await import("../applications.js");
setConnectedApplications(() => applications);
registerPlugin({ id: "fixture", surface: () => null });
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

test("a surface reads the connected applications and is told when they change", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  globalThis.seenApplications = [];
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export function mount(root, context) {
    globalThis.seenApplications.push(context.runtime.applications.read());
    context.runtime.applications.on((value) => globalThis.seenApplications.push(value));
    return { dispose() {} };
  }`)}`;
  await mountSurface(document.querySelector("#slot"),
    { module: moduleUrl, surfaceId: "tab-applications", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] });
  applications = {};
  notifyConnectedApplications();
  assert.deepEqual(globalThis.seenApplications, [{ shell }, {}]);
  dom.window.close();
});
