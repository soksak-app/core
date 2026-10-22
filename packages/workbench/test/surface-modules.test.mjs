import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { recordOrigin } from "../tab-reports.js";

// The diagnostics module is started by environment at registration and handed out as pluginDiagnostics. The consumer test replaces that boundary.
const diagnostics = { attach() {} };
mock.module("../environment.js", { namedExports: {
  pluginDiagnostics: async (id) => (id === "fixture-diagnostics" ? diagnostics : null),
} });

// The plugin below has no diagnostics module, like a release build.
for (const id of ["fixture", "fixture-integration"]) registerPlugin({ id, surface: () => null });
// In the app, the plane starts before the surfaces and sets the function that computes the text scale of a surface. Here every surface has scale 1.
const { setSurfaceTextSize } = await import("../text-size.js");
setSurfaceTextSize(() => 1);

test("a surface context carries its plugin's diagnostic module", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  registerPlugin({ id: "fixture-diagnostics", surface: () => null });
  const moduleUrl = "data:text/javascript,export function mount(root,c){globalThis.mountedDiagnostics=c.diagnostics;return {dispose(){}}}";
  recordOrigin("tab-diagnostics", null);
  await mountSurface(document.querySelector("#slot"),
    { module: moduleUrl, surfaceId: "tab-diagnostics", pluginId: "fixture-diagnostics", composition: { kind: "dom" }, declarations: {}, sidecars: [] });
  assert.equal(globalThis.mountedDiagnostics, diagnostics);
  dom.window.close();
});

test("surface mount keeps one module host when a tab moves slots", async () => {
  const dom = new JSDOM("<main><div id=a></div><div id=b></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  const moduleUrl = "data:text/javascript,export function mount(root,c){c.status.report('ready');return {dispose(){}}}";
  recordOrigin("tab-1", null);
  const surface = { module: moduleUrl, surfaceId: "tab-1", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] };
  const first = document.querySelector("#a");
  const second = document.querySelector("#b");
  const mounts = await Promise.all([mountSurface(first, surface), mountSurface(first, surface)]);
  assert.equal(mounts[0], mounts[1], "concurrent layout notifications must share one module mount");
  assert.equal(first.querySelectorAll(".surface-module-host").length, 1);
  await mountSurface(second, surface);
  assert.equal(second.querySelectorAll(".surface-module-host").length, 1);
  assert.equal(first.querySelectorAll(".surface-module-host").length, 0);
  dom.window.close();
});

test("selecting a parked tab reattaches its existing module host", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  const moduleUrl = "data:text/javascript,export function mount(){return {dispose(){}}}";
  recordOrigin("tab-park-first", null);
  const first = { module: moduleUrl, surfaceId: "tab-park-first", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] };
  recordOrigin("tab-park-second", null);
  const second = { module: moduleUrl, surfaceId: "tab-park-second", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] };
  const slot = document.querySelector("#slot");

  await mountSurface(slot, first);
  const firstHost = slot.querySelector(".surface-module-host");
  await mountSurface(slot, second);
  const secondHost = slot.querySelector(".surface-module-host");
  assert.notEqual(firstHost, secondHost);
  assert.equal(slot.querySelectorAll(".surface-module-host").length, 1);

  await mountSurface(slot, first);
  assert.equal(firstHost.parentNode, slot);
  assert.equal(slot.querySelectorAll(".surface-module-host").length, 2);
  assert.equal(firstHost.dataset.surfaceSuspended, undefined);
  dom.window.close();
});

test("a mounted module registers and releases its declared exposure through the real registry", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { registry } = await import("../exposure.js");
  const { mountSurface, disposeSurface } = await import("../surface-modules.js");
  const pluginId = "fixture-integration";
  const surfaceId = "fixture-module-surface";
  recordOrigin(surfaceId, null);
  const declarations = {
    status: [],
    commands: [{
      name: `${pluginId}.ping`, description: "Pings the fixture.",
      params: { type: "object" }, result: { type: "null" },
    }],
    dom: [],
  };
  registry.declare("core", {
    status: [
      { name: "core.surface.document", description: "Surface document.", schema: { type: "object" } },
      { name: "core.surface.input", description: "Surface input.", schema: { type: "array" } },
    ],
    commands: [{ name: "core.surface.hit", description: "Tests a surface point.", params: { type: "object" }, result: { type: "boolean" } }],
    dom: [],
  });
  registry.declare(pluginId, declarations);
  registry.configure({ surfacePlugin: (id) => id === surfaceId ? pluginId : null });
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    if (!context.runtime.clipboard || typeof context.runtime.clipboard.writeText !== 'function') throw new Error('clipboard capability is missing');
    await context.exposure.command('${pluginId}.ping', () => null);
    return { dispose() { context.exposure.dispose(); } };
  }`)}`;
  const surface = {
    module: moduleUrl, surfaceId, pluginId, declarations, sidecars: [], composition: { kind: "dom" },
  };
  await mountSurface(document.querySelector("#slot"), surface);
  assert.deepEqual(registry.registrants("command", `${pluginId}.ping`), [surfaceId]);
  assert.deepEqual(registry.registrants("status", "core.surface.document"), [surfaceId]);
  assert.deepEqual(registry.registrants("status", "core.surface.input"), [surfaceId]);
  assert.deepEqual(registry.registrants("command", "core.surface.hit"), [surfaceId]);
  await disposeSurface(surfaceId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registry.registrants("command", `${pluginId}.ping`), []);
  dom.window.close();
});

test("surface mount readiness separates module mount from native presentation", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js");
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export async function mount() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { dispose() {} };
  }`)}`;
  const surface = { module: moduleUrl, surfaceId: "tab-mounted", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] };
  recordOrigin("tab-mounted", null);
  const mounting = mountSurface(document.querySelector("#slot"), surface);
  await waitSurfaceCompositionDeclared(surface.surfaceId);
  await mounting;
  dom.window.close();
});

test("a tab that leaves the layout during its mount reads the factor it was mounted with", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface } = await import("../surface-modules.js");
  let inLayout = true;
  setSurfaceTextSize((id) => (id === "tab-leaving" && inLayout ? 1.5 : null));
  // The module reads the scale after the tab left the plane while it was waiting (a split card that is closed soon after).
  globalThis.leaveLayout = () => { inLayout = false; };
  const moduleUrl = "data:text/javascript,export async function mount(root,c){await Promise.resolve();" +
    "globalThis.leaveLayout();globalThis.readFactor=c.runtime.textSize.read();return {dispose(){}}}";
  recordOrigin("tab-leaving", null);
  await mountSurface(document.querySelector("#slot"),
    { module: moduleUrl, surfaceId: "tab-leaving", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] });
  assert.equal(globalThis.readFactor, 1.5);
  dom.window.close();
});

test("a surface announces its removal through context.closing before the module is disposed", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { mountSurface, disposeSurface } = await import("../surface-modules.js");
  globalThis.closingSeen = [];
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export function mount(root, context) {
    globalThis.closingSeen.push(["mount", context.closing.aborted]);
    context.closing.addEventListener("abort", () => globalThis.closingSeen.push(["abort", true]));
    return { dispose() { globalThis.closingSeen.push(["dispose", context.closing.aborted]); } };
  }`)}`;
  const surfaceId = "tab-closing";
  recordOrigin(surfaceId, null);
  await mountSurface(document.querySelector("#slot"),
    { module: moduleUrl, surfaceId, pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] });
  await disposeSurface(surfaceId);
  assert.deepEqual(globalThis.closingSeen, [["mount", false], ["abort", true], ["dispose", true]]);
  dom.window.close();
});

test("a surface module runs a command of core through runtime.command and cannot run a command of a plugin", async () => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const { registry } = await import("../exposure.js");
  const { mountSurface, disposeSurface } = await import("../surface-modules.js");
  registry.declare("core", {
    status: [],
    commands: [{ name: "core.fixture.echo", description: "Answers its parameters.", params: { type: "object" }, result: { type: "object" } }],
    dom: [],
  });
  const received = [];
  registry.command("core.fixture.echo", (params) => { received.push(params); return { echoed: params.value }; });
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    globalThis.commandReply = await context.runtime.command('core.fixture.echo', { value: 7 });
    globalThis.commandRefusal = await context.runtime.command('fixture.ping', {}).then(() => null, (error) => error.message);
    return { dispose() {} };
  }`)}`;
  recordOrigin("tab-core-command", null);
  await mountSurface(document.querySelector("#slot"),
    { module: moduleUrl, surfaceId: "tab-core-command", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] });
  assert.deepEqual(globalThis.commandReply, { echoed: 7 });
  assert.deepEqual(received, [{ value: 7 }]);
  assert.equal(globalThis.commandRefusal, "runtime.command: fixture.ping is not a command of core");
  await disposeSurface("tab-core-command");
  dom.window.close();
});

// The trace is recorded through a fresh instance of the module, so the mocked trace is the one that mountSurface calls.
let tracedInstances = 0;
async function tracedSurfaceModules(t, clock) {
  const records = [];
  t.mock.method(performance, "now", () => clock.now);
  t.mock.module("../performance.js", { exports: {
    timed: async (_name, answer) => answer(),
    trace: (event, fields) => { records.push({ event, ...fields }); },
    traceEnabled: () => true,
    setTraceEnabled: async () => {},
    reportTraceAtStart: async () => {},
  } });
  const { mountSurface } = await import(`../surface-modules.js?mount-trace-${tracedInstances++}`);
  return { records, mountSurface };
}

test("a surface mount writes one surface.mount trace with its plugin, its surface and the elapsed milliseconds", async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const clock = { now: 1000 };
  const { records, mountSurface } = await tracedSurfaceModules(t, clock);
  globalThis.advanceClock = (ms) => { clock.now += ms; };
  const moduleUrl = "data:text/javascript,export async function mount(root,c){await Promise.resolve();globalThis.advanceClock(42.5);return {dispose(){}}}";
  recordOrigin("tab-mount-trace", null);
  await mountSurface(document.querySelector("#slot"),
    { module: moduleUrl, surfaceId: "tab-mount-trace", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] });
  const mounts = records.filter(({ event }) => event === "surface.mount");
  assert.equal(mounts.length, 1, `expected one surface.mount trace, found ${mounts.length}`);
  assert.equal(mounts[0].plugin, "fixture");
  assert.equal(mounts[0].surface, "tab-mount-trace");
  assert.equal(typeof mounts[0].ms, "number", "the elapsed time must be a number");
  assert.equal(mounts[0].ms, 42.5, "the elapsed time must cover the awaited module mount");
  dom.window.close();
});

test("a failed surface mount writes no surface.mount trace", async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  const clock = { now: 1000 };
  const { records, mountSurface } = await tracedSurfaceModules(t, clock);
  const moduleUrl = "data:text/javascript,export function mount(){throw new Error('fixture mount failed')}";
  recordOrigin("tab-mount-failed", null);
  await assert.rejects(mountSurface(document.querySelector("#slot"),
    { module: moduleUrl, surfaceId: "tab-mount-failed", pluginId: "fixture", composition: { kind: "dom" }, declarations: {}, sidecars: [] }),
  /fixture mount failed/);
  assert.deepEqual(records.filter(({ event }) => event === "surface.mount"), [], "a failed mount must not write surface.mount");
  dom.window.close();
});
