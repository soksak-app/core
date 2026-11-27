// The project home lists the projects of the window and asks the folder of each listed project (docs/spec/projects.md#project-home) through its declared commands. The
// host calls and the notices of the page are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md); the
// case is selected before the modules are imported, because the page reads the host when it imports them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

const wire = selectPageWire("home-removed-project");
const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
Object.defineProperty(document.getElementById("plane"), "clientWidth", { value: 800 });
Object.defineProperty(document.getElementById("plane"), "clientHeight", { value: 600 });
const cardMetrics = document.createElement("style");
cardMetrics.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.append(cardMetrics);
const { installExposure, registry } = await import("../exposure.js");
installExposure(exposureFile);
const { createHome } = await import("../home.js");
const { installCoreExposure } = await import("../core-exposure.js");
const { pageMemorySaver } = await import("./support/memory-saver.mjs");
const { adopt, capture, fresh, settle } = await import("../plane.js");
const { checkStoredLayout } = await import("../stored-layout.js");
const projects = await import("../projects.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { connectSettings } = await import("../settings.js");
const { installEnvironment } = await import("../environment.js");
// The environment of the window holds one placeholder tab, so the page loads without a plugin (the projects module needs it).
assert.deepEqual(installEnvironment({
  runtime: "runtime",
  workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture-home", title: "Note" }] } } },
  sidebars: { sets: [], links: [] },
}, { plugins: [] }), []);

const PROJECT = { id: "prj-a", title: "test", root: "/work/missing", color: "#fff", named: 1, activeSpaceId: "s", spaces: [{ id: "s", title: "SPACE1", layout: fresh() }], settings: {} };

test("the project home asks the folder of a listed project", async () => {
  projects.onSwitch({
    check: checkStoredLayout, save: capture, load: adopt, update: settle,
    retain: async () => {}, presented: async () => {}, empty: async () => {}, settleTabs: async () => true,
  });
  const root = document.createElement("div");
  document.body.append(root);
  const home = createHome(root);
  await installCoreExposure({ home, renames: { state: () => null }, chrome: () => null, drawn: async () => {}, memorySaver: await pageMemorySaver() });
  projects.begin({ common: {}, projects: [PROJECT], open: [] });
  home.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(home.state().rows, ["prj-a"], "the listed project is shown");
  projects.begin({ common: {}, projects: [], open: [] });
  home.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(home.state().rows, [], "the empty list shows no project and asks no folder");
  projects.begin({ common: {}, projects: [PROJECT], open: [] });
  home.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(home.state().rows, ["prj-a"], "the project is listed again");
  wire.finish();
});
