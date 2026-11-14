// Checks the lines that one presentation failure writes to the application log. The requester that received the failure reports it, and any other path that received the same failure does not write it again
// (docs/spec/hosts.md#application-log). In the page, that requester is failed of the layout queue, and it shows the failure
// through the error display of the main document. The connection is the layout wiring of page-layout.js that index.html uses, and the surface of the
// layout is mounted by surface-modules.js. The test gives the layout the publication of the placement, the render of the plane, and the animation frame; the host calls
// are answered by the page-wire case of the test (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import { recordsOf, shownRecord } from "./support/records.mjs";

const TIMEOUT = "the current image raster did not present within 10s; pending tab-1/view generation 2 raster 1 sequence 0 presented 0/0 surface visible";

// The case is selected before the first module that imports host.js is imported, because host.js reads the host when it is imported.
const wire = selectPageWire("presentation-failure-lines-timeout");

test("one presentation timeout writes one workbench error line", async () => {
  const dom = new JSDOM('<div id="plane"></div><div id="slot"></div><div id="applicationError"></div>');
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  // The animation frame of the document. Node does not have one, so it runs at the requested place.
  globalThis.requestAnimationFrame = (run) => run(0);
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = () => {};
  const { report, surfaces } = await import("../host.js");
  const { flushEvents } = await import("../page-log.js");
  const { createErrorDisplay, createPageLayout } = await import("../page-layout.js");
  const { connectExposure, registry } = await import("../exposure.js");
  const { registerPlugin } = await import("../registry.js");
  const { recordOrigin } = await import("../tab-reports.js");
  const { setSurfaceTextSize } = await import("../text-size.js");
  const { authorizeSurface, disposeSurface, mountSurface, waitSurfaceCompositionDeclared } = await import("../surface-modules.js");
  setSurfaceTextSize(() => 1);

  const composition = { kind: "view", page: "ui/page.html", regions: [{ name: "view", kind: "image" }], overlays: [] };
  const pluginId = "fixture-presentation-plugin";
  recordOrigin("tab-1", null, "test fixture");
  registerPlugin({ id: pluginId, surface: () => null });
  try {
    // The surface of the layout is a mounted view that has declared its composition, so the placement sends it to the host.
    authorizeSurface("tab-1");
    await mountSurface(document.querySelector("#slot"), {
      module: null, surfaceId: "tab-1", pluginId,
      declarations: { status: [], commands: [], element: [] }, sidecars: [], composition,
    });
    await waitSurfaceCompositionDeclared("tab-1");

    const record = {
      surfaces: [{
        id: "tab-1", dim: false, visible: true,
        surface: { composition },
        applied: { x: 0, y: 0, w: 10, h: 10 },
      }],
      settled: true, drawn: false, titlebar: 40,
    };
    // The presentation that the render of the plane committed (onRender of index.html). It requests the presentation of the drawn layout from the host.
    let rendered = Promise.resolve();
    const showError = createErrorDisplay({ document, changed: () => {} });
    // The layout queue shows the failure before it calls setVerify with the failed row, so the failure is queued when this resolves.
    const failed = Promise.withResolvers();
    const page = createPageLayout({
      document, showError, setVerify: (rows) => { if (rows.some((row) => !row.ok)) failed.resolve(); }, log: () => {}, surfaces,
      plane: {},
      compositor: { publishAhead: () => surfaces.place(record) },
      textSize: () => 1,
      rendered: () => rendered,
      compositionState: () => ({ state: "declared" }),
    });
    await connectExposure({ settled: page.drawn, report });
    await surfaces.theme({ scheme: "light", tokens: {} });
    registry.declare("core", { status: [], element: [], commands: [{
      name: "core.fixture.split", description: "Splits.", params: { type: "object", properties: {} }, result: { type: "null" },
    }] });
    registry.command("core.fixture.split", () => {
      page.onLayout(new Map(), () => { rendered = surfaces.place({ ...record, drawn: true }); }, new Map(), 40, () => true);
      return null;
    });

    assert.equal(await registry.run("core.fixture.split"), null);
    await failed.promise;
    await flushEvents();
    const lines = wire.calls.flatMap(({ name, payload }) => recordsOf(name, payload).map(shownRecord));
    assert.deepEqual(lines, [`error workbench workbench: surface presentation failed: ${TIMEOUT}`],
      "one presentation timeout must write exactly the line of the display that shows it");
  } finally {
    await disposeSurface("tab-1");
    dom.window.close();
  }
  wire.finish();
});
