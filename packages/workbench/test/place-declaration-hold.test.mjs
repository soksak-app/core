import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The page-wire case answers the host calls of the page (docs/spec/cases/page-wire/README.md). It is selected before the modules that read
// the host are imported.
const wire = selectPageWire("place-declaration-hold-declare");
const { registerPlugin } = await import("../registry.js");
const { recordOrigin } = await import("../tab-reports.js");
const { setSurfaceTextSize } = await import("../text-size.js");

setSurfaceTextSize(() => 1);

const settled = () => new Promise((resolve) => setImmediate(resolve));

// A preparation keeps an unmounted view out of its host request, and the host removes a surface that a place leaves out, its
// composition declaration included (docs/spec/native-surfaces.md#view-surfaces). After a page reload the host still holds the view of
// the earlier page under the same surface id, so a declaration that the new page sends while that preparation is in flight is removed
// by it, and the next placement of the view is refused for having no declaration. The preparation holds the declaration of each view
// that it leaves out until it has its reply.
test("a preparation holds the declaration of each view it leaves out until the host replies", { timeout: 5000 }, async () => {
  const dom = new JSDOM('<div id="plane"><div id="mounted"></div><div id="cold"></div></div>');
  globalThis.document = dom.window.document;
  const { surfaces } = await import("../host.js");
  const modules = await import("../surface-modules.js");
  const names = () => wire.calls.map(({ name }) => name);
  const view = (id) => {
    recordOrigin(id, null, "test fixture");
    const slot = document.querySelector(`#${id.split("-")[0]}`);
    slot.dataset.nativeSurfaceId = id;
    return { slot, surface: { module: null, surfaceId: id, pluginId: "probe",
      declarations: { status: [], commands: [], element: [] }, sidecars: [],
      composition: { kind: "view", page: "ui/page.html" } } };
  };
  const record = (id) => ({ id, plugin: "probe", dim: false, visible: true,
    surface: { pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } }, applied: { x: 0, y: 0, w: 3, h: 4 } });
  registerPlugin({ id: "probe", surface: () => null });
  const mountedView = view("mounted-view");
  const coldView = view("cold-view");
  try {
    await surfaces.theme({ scheme: "dark", tokens: {} });
    // The mounted view has declared its composition, so a preparation sends it; the other view is not mounted when the preparation starts.
    modules.authorizeSurface(mountedView.surface.surfaceId);
    await modules.mountSurface(mountedView.slot, mountedView.surface);
    await modules.waitSurfaceCompositionDeclared(mountedView.surface.surfaceId);
    await settled();
    const placing = surfaces.place({ surfaces: [record("mounted-view"), record("cold-view")], settled: true, drawn: false, titlebar: 40 });
    await settled();
    const request = wire.calls.find(({ name }) => name === "syncSurfaces").payload;
    assert.deepEqual(request.surfaces.map(({ id }) => id), ["mounted-view"], "the preparation sent an unmounted view");
    // The view that the preparation left out mounts while the preparation waits for its reply. Its declaration waits for that reply.
    modules.authorizeSurface(coldView.surface.surfaceId);
    const coldMounting = modules.mountSurface(coldView.slot, coldView.surface);
    await settled();
    assert.deepEqual(names(), ["setTheme", "compositionDeclare", "syncSurfaces"],
      "the view that the preparation left out declared before the host replied");
    wire.release();
    await placing;
    await coldMounting;
    await settled();
    // The reply is the mark before the hold may end, so the order shows the hold ended after the reply and not before it.
    assert.deepEqual(names(), ["setTheme", "compositionDeclare", "syncSurfaces", "compositionDeclare"],
      "the hold did not end with the reply of the preparation");
    assert.deepEqual(wire.calls.filter(({ name }) => name === "compositionDeclare").map(({ payload }) => payload.surface),
      ["mounted-view", "cold-view"], "the preparation did not hold the declaration of the view it left out");
  } finally {
    await modules.disposeSurface(mountedView.surface.surfaceId);
    await modules.disposeSurface(coldView.surface.surfaceId);
    dom.window.close();
  }
  wire.finish();
});
