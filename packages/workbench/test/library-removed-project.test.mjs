// The host calls of the page are answered by the page-wire case of this test (docs/spec/cases/page-wire/README.md). The case is selected before
// the modules that read the host are imported, because they read it when they are imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

const wire = selectPageWire("library-removed-project");

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
const projects = await import("../projects.js");
const { createLibrary } = await import("../library.js");

installExposure(exposureFile);

// The replies of the host settle in the turns that follow the call, so a test waits one macrotask after a call that no promise of the page ends.
const settled = () => new Promise((resolve) => setImmediate(resolve));

// A removed project withdraws its folder error, so the same project added again with the same missing folder reports the error again.
test("a removed project hides its folder error, and the error is written again when the project is added again", async () => {
  const project = { id: "prj-a", title: "test", root: "/work/missing", spaces: [{ id: "s" }], activeSpaceId: "s" };
  // The registry of the window changes through the snapshot of the start document (docs/spec/native-host.md#page-start).
  const list = async (listed) => {
    projects.begin({ common: {}, projects: listed, open: [] });
    await settled();
  };
  await list([project]);
  const library = createLibrary(document.getElementById("library"));
  /** The lines `<where>: <text>` of the error records that the page sent in the log batches of its wire, for the project folder. */
  const written = () => wire.calls
    .filter(({ name, payload }) => name === "log" && payload?.action === "batch")
    .flatMap(({ payload }) => payload.events)
    .filter((event) => event.event === "workbench.record.error" && event.fields.where === "library project /work/missing")
    .map((event) => `${event.fields.where}: ${event.fields.text}`);
  // The project is added and its folder is missing. The error is written once.
  library.render();
  await library.idle();
  await flushEvents();
  assert.equal(written().length, 1, "the missing folder error is not written when the project is added");
  // The project leaves the library list. Its card and its folder result are removed.
  await list([]);
  library.refreshFolders();
  library.render();
  await library.idle();
  await flushEvents();
  assert.equal(document.querySelector('[data-project-id="prj-a"]'), null, "the card of a removed project is still shown");
  // The same project is added again with the same missing folder. The error is written again.
  await list([project]);
  library.refreshFolders();
  library.render();
  await library.idle();
  await flushEvents();
  assert.equal(written().length, 2, "the error of a project added again is not written");
  wire.finish();
  dom.window.close();
});
