// The library asks the host for the folder of each listed project and shows what the host answers. The host calls of the page are answered by
// the page-wire case of each test (docs/spec/cases/page-wire/README.md). The case of the first test is selected before the modules that
// read the host are imported, because they read it when they are imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

const firstWire = selectPageWire("library-folders-once");

// The page of the window is drawn in this document, which the modules read when they are imported.
const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/" });
dom.window.matchMedia = (query) => ({ media: query, matches: true,
  addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
// The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
globalThis.devicePixelRatio = dom.window.devicePixelRatio;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
globalThis.PointerEvent = dom.window.PointerEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
const planeEl = document.getElementById("plane");
Object.defineProperty(planeEl, "clientWidth", { value: 800 });
Object.defineProperty(planeEl, "clientHeight", { value: 600 });
const style = document.createElement("style");
style.textContent = ".card { --bw: 1px; --divider: 1px; }";
document.head.appendChild(style);

const { installExposure } = await import("../exposure.js");
const { flushEvents } = await import("../page-log.js");
const { HostWorkspaceStore } = await import("../host-store.js");
const { checkStoredLayout } = await import("../stored-layout.js");
const { adopt, capture, settle, settleModifiedTabsToClose } = await import("../plane.js");
const { disposeSurfacesExcept } = await import("../surface-modules.js");
const projects = await import("../projects.js");
const { createLibrary } = await import("../library.js");

installExposure(exposureFile);

// The replies of the host settle in the turns that follow the call, so a test waits one macrotask after a call that no promise of the page ends.
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** The lines `<where>: <text>` of the error records that the page sent in the log batches of its wire, for the place where. */
const written = (wire, where) => wire.calls
  .filter(({ name, payload }) => name === "log" && payload?.action === "batch")
  .flatMap(({ payload }) => payload.events)
  .filter((event) => event.event === "workbench.record.error" && event.fields.where === where)
  .map((event) => `${event.fields.where}: ${event.fields.text}`);

// A missing folder is reported once for its project entry. While the library checks the folder again after each project list change, the last known result stays on the card, so the error display is not withdrawn and written again.
test("a missing project folder is reported once across project list changes, and a folder that appears again hides the error", async () => {
  const project = { id: "prj-a", title: "test", root: "/work/missing", spaces: [{ id: "s" }], activeSpaceId: "s" };
  // The window starts with the project in its store snapshot, so the library lists it (docs/spec/native-host.md#page-start).
  projects.begin({ common: {}, projects: [project], open: [] });
  await settled();
  const library = createLibrary(document.getElementById("library"));
  const missing = () => written(firstWire, "library project /work/missing");
  library.render();
  await library.idle();
  await flushEvents();
  // The project list changes three times. Each change checks the folder again and renders the library. The host answers that the folder is missing.
  for (let i = 0; i < 3; i++) {
    library.refreshFolders();
    library.render();
    await library.idle();
    await flushEvents();
  }
  assert.deepEqual(missing(), ["library project /work/missing: 폴더가 없습니다."],
    "the missing folder error is not written once");
  // The folder appears again. The next check finds no error, so the error display is withdrawn.
  library.refreshFolders();
  library.render();
  await library.idle();
  await flushEvents();
  const card = document.querySelector('[data-project-id="prj-a"]');
  assert.equal(card.querySelector(".library-project__missing"), null, "the error of a folder that appeared again is still shown");
  assert.equal(card.querySelector('[data-expose="core.library.open"]').disabled, false);
  // The folder disappears again. The error is shown and written once more.
  library.refreshFolders();
  library.render();
  await library.idle();
  await flushEvents();
  assert.equal(missing().length, 2, "the error of a folder that disappeared again is not written");
  firstWire.finish();
});

// For a project whose folder cannot be read, the library shows the reason before it opens, reports it to core.library, and allows removing the project from the library.
test("a project whose folder cannot be read shows the reason in the library and can be removed there", async () => {
  const wire = selectPageWire("library-folders-remove");
  // The operations of the plane that the project module calls while it reads the registry and removes a project. The page layout of index.html
  // answers presented and empty, and the removal of a project that no window shows calls neither of them.
  projects.onSwitch({ check: checkStoredLayout, save: capture, load: adopt, update: settle, retain: disposeSurfacesExcept,
    settleTabs: settleModifiedTabsToClose });
  // The window reads the registry of two projects from the host: the folder of the first does not exist.
  await projects.initialise(new HostWorkspaceStore(host));
  const library = createLibrary(document.getElementById("library"));
  library.render();
  await library.idle();
  const state = library.state();
  assert.deepEqual(state.folderErrors, { "prj-a": "project directory does not exist: /work/missing" });
  const card = document.querySelector('[data-project-id="prj-a"]');
  // The path appears only once, in the path line of the card.
  assert.equal(card.querySelector(".library-project__missing")?.textContent, "폴더가 없습니다.");
  assert.equal(document.querySelector('[data-project-id="prj-b"] .library-project__missing'), null);
  assert.equal(card.querySelector('[data-expose="core.library.open"]').disabled, true, "the card of a missing folder can still be pressed");
  assert.equal(document.querySelector('[data-project-id="prj-b"] [data-expose="core.library.open"]').disabled, false);
  const remove = card.querySelector('[data-expose="core.library.remove"]');
  assert.deepEqual([remove?.dataset.command, remove?.dataset.params], ["core.library.remove", JSON.stringify({ id: "prj-a" })],
    "the library card has no remove control bound to core.library.remove");
  await library.actions.remove("prj-a");
  // The operation that starts the removal is an info event of the class call, which the gate counts; the flush sends the count.
  await flushEvents();
  assert.deepEqual(wire.calls.filter(({ name, payload }) => name === "workspace" && payload.kind === "remove").map(({ payload }) => payload.id),
    ["prj-a"]);
  wire.finish();
  dom.window.close();
});
