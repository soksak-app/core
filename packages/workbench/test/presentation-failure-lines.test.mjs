// Checks the lines that one presentation failure writes to the application log. The requester that received the failure reports it, and any other path that received the same failure does not write it again
// (docs/spec/hosts.md#application-log). In the page, that requester is failed of the layout queue, and it shows the failure
// through the error display of the main document. The connection is the layout wiring of page-layout.js that index.html uses, and this test fakes only the
// host bridge, the compositor, the render of the plane, and the animation frame.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { clockAnswer, recordsOf, settled, shownRecord } from "./support/records.mjs";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

test("one presentation timeout writes one page error line", async () => {
  const dom = new JSDOM('<div id="plane"></div><div id="applicationError"></div>');
  globalThis.document = dom.window.document;
  // The animation frame of the document. Node does not have one, so it runs at the requested place.
  globalThis.requestAnimationFrame = (run) => run(0);
  const lines = [];
  mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (surfaceId) => surfaceId === "tab-1" ? { surfaceId } : null,
    waitSurfaceCompositionDeclared: async () => {},
  } });
  mock.module("@soksak/runtime", { namedExports: { windows: null, host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "log") { if (clockAnswer(name, request)) return clockAnswer(name, request); for (const record of recordsOf(name, request)) lines.push(shownRecord(record)); return; }
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") return {
        ticket: 1,
        placements: [{ id: "tab-1", x: 0, y: 0, w: 10, h: 10, visible: true }],
        chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: 40 },
      };
      if (name === "presentSurfaces") throw new Error(TIMEOUT);
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { report, surfaces } = await import("../host.js");
  const { createErrorDisplay, createPageLayout } = await import("../page-layout.js");
  const { connectExposure, registry } = await import("../exposure.js");

  const record = {
    surfaces: [{
      id: "tab-1", dim: false, visible: true,
      surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "view", kind: "image" }], overlays: [] } },
      applied: { x: 0, y: 0, w: 10, h: 10 },
    }],
    settled: true, drawn: false, titlebar: 40,
  };
  // The presentation that the render of the plane committed (onRender of index.html). It requests the presentation of the drawn layout from the host.
  let rendered = Promise.resolve();
  const showError = createErrorDisplay({ document, changed: () => {} });
  const page = createPageLayout({
    document, showError, setVerify: () => {}, log: () => {}, surfaces,
    plane: {},
    compositor: { publishAhead: () => surfaces.place(record) },
    textSize: () => 1,
    rendered: () => rendered,
    waitSurfaceCompositionDeclared: async () => {},
  });
  await connectExposure({ settled: page.drawn, report });
  await surfaces.theme({ scheme: "light", tokens: {} });
  registry.declare("core", { status: [], dom: [], commands: [{
    name: "core.fixture.split", description: "Splits.", params: { type: "object", properties: {} }, result: { type: "null" },
  }] });
  registry.command("core.fixture.split", () => {
    page.onLayout(new Map(), () => { rendered = surfaces.place({ ...record, drawn: true }); }, new Map(), 40);
    return null;
  });

  assert.equal(await registry.run("core.fixture.split"), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, [`error page page: surface presentation failed: ${TIMEOUT}`],
    "one presentation timeout must write exactly the line of the display that shows it");
  dom.window.close();
});
