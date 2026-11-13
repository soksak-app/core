import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The host module reads the host wire when it is first imported, so the first test selects its case before that import. Each test
// selects its own case (docs/spec/cases/page-wire/README.md). The promise of setImmediate ends after the calls that the page started
// in the current task have reached the wire.
const sent = () => new Promise((resolve) => setImmediate(resolve));

test("a layout published before drawing waits for the host's placement answer", async () => {
  const wire = selectPageWire("compositor-placement-wait");
  const dom = new JSDOM(`<div id="plane"><div data-card-id="card">
    <div data-native-surface data-native-surface-id="surface" data-native-plugin="probe" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  // The compositor updates the paint clip in the frame after a layout reply, so the test provides the rAF of the page.
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const card = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 });
  slot.getBoundingClientRect = () => ({ left: 2, top: 30, width: 196, height: 100 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "probe", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  const { onCommit, placementPending, publishAhead, setSlotSurface } = await import("../compositor.js");
  const { surfaces } = await import("../host.js");
  setSlotSurface(slot, { surfaceId: "surface", pluginId: "probe", composition: { kind: "dom" } });
  let prepared;
  onCommit((record) => {
    prepared = record;
    return surfaces.place(record);
  });

  const pending = publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "surface", dim: false, inset: { left: 2, top: 30, width: 4, height: 50 }, grid: 2 }]]));
  assert.equal(typeof pending?.then, "function", "the caller needs the host's promise before it draws");
  // Verify V7c judges the prediction on the grid that its layout was made on, which the display can leave before the check.
  assert.equal(prepared.surfaces[0].grid, 2, "the prediction does not carry the grid of its layout");
  // The record carries the viewport that its layout was made at, which the host keeps with the layout transaction of the preparation
  // (docs/spec/native-surfaces.md#layout-transaction).
  assert.deepEqual(prepared.viewport, { width: 1024, height: 768 }, "the prediction does not carry the viewport of its layout");
  assert.equal(placementPending(), true, "the current DOM commit is waiting for the host placement answer");
  let drawn = false;
  // The order shows that the DOM drew only after the native placement answered: the answer is pushed right before it is given.
  const order = [];
  pending.then(() => { drawn = true; order.push("drawn"); });
  // A preparation is applied inside the layer transaction of the window and does not appear on screen before the commit. When a surface
  // whose position was measured is hidden, the visible surface on screen cannot receive input in the meantime (docs/spec/native-surfaces.md).
  assert.equal(prepared.surfaces[0].visible, true,
    "native preparation keeps a surface whose future slot was measured visible at its new rectangle");
  assert.deepEqual(prepared.surfaces[0].declared, { x: 22, y: 30, w: 176, h: 100 });
  // The page sends the placement request in a task after the commit, so the call is in the wire once the task has ended. The
  // order shows that the DOM drew only after the native placement answered: the answer is released right before it is given.
  await sent();
  assert.deepEqual(wire.calls.map(({ name }) => name), ["syncSurfaces"], "the page did not send the placement request");
  order.push("answered");
  wire.release();
  const placed = await pending;
  assert.deepEqual(order, ["answered", "drawn"], "the DOM drew while the native placement was outstanding");
  assert.deepEqual(placed, [{ id: "surface", visible: true, scale: 2, x: 22, y: 30, w: 176, h: 100 }]);
  assert.equal(drawn, true);
  assert.equal(placementPending(), false, "the host answer seats the current commit");

  const replacement = publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "replacement", dim: false, inset: null }]]));
  assert.equal(typeof replacement?.then, "function", "replacing content must prepare the existing native view before drawing");
  assert.equal(prepared.surfaces[0].visible, false, "content with no matching future slot must be hidden before its card changes");
  await sent();
  wire.release();
  await replacement;

  // A surface that has no card in the next layout is hidden too. The host requires visible to be a boolean. The layout is the same as
  // the replacement, so the page sends no request and the placement of the replacement stands.
  const removed = publishAhead(new Map(), new Map());
  assert.strictEqual(prepared.surfaces[0].visible, false, "content whose card leaves the layout must be hidden with a boolean");
  await removed;
  const resizedSidebar = publishAhead(new Map([["card", { x: 20, y: 0, w: 400, h: 150 }]]),
    new Map([["card", { id: "surface", dim: false, inset: { left: 192, top: 30, width: 194, height: 50 } }]]));
  assert.deepEqual(prepared.surfaces[0].declared, { x: 212, y: 30, w: 206, h: 100 },
    "native preparation reused the old sidebar width instead of the captured future inset");
  await sent();
  wire.release();
  await resizedSidebar;
  wire.finish();
  dom.window.close();
});

test("a surface in a hidden fullscreen sibling stays mounted and becomes invisible", async () => {
  const wire = selectPageWire("compositor-hidden-sibling-publish");
  const dom = new JSDOM(`<div id="plane"><div data-card-id="hidden-card" hidden>
    <div data-native-surface data-native-surface-id="hidden-surface" data-native-plugin="fullscreen-probe" data-native-layer="0"></div>
  </div></div>`, { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "fullscreen-probe", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  const slot = document.querySelector("[data-native-surface]");
  const compositor = await import("../compositor.js?fullscreen-sibling");
  const { surfaces } = await import("../host.js");
  compositor.setSlotSurface(slot, { surfaceId: "hidden-surface", pluginId: "fullscreen-probe", composition: { kind: "dom" } });
  let width = 100, height = 100;
  slot.getBoundingClientRect = () => ({left:0,top:0,width,height});
  let record;
  compositor.onCommit((value) => {
    record = value;
    return surfaces.place(value);
  });
  try {
    await compositor.publish();
    assert.equal(record.surfaces.length, 1, "hidden state removed the live surface");
    assert.equal(record.surfaces[0].visible, false, "a hidden card still presents its native surface");
    assert.ok(document.querySelector('[data-native-surface-id="hidden-surface"][data-native-surface]'));
    document.querySelector('[data-card-id="hidden-card"]').hidden = false;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, true, "restoring the card did not restore its native visibility");
    width = 0;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, false, "a zero-area slot presents its retained native frame");
    assert.equal(record.surfaces.length, 1, "a zero-area slot disposed its live surface");
    width = 100;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, true, "restoring the slot area did not restore visibility");
    height = 0;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, false, "a zero-height slot presents its retained native frame");
    assert.equal(record.surfaces.length, 1, "a zero-height slot disposed its live surface");
    height = 100;
    await compositor.publish();
    assert.equal(record.surfaces[0].visible, true, "restoring the slot height did not restore visibility");
    wire.finish();
  } finally { dom.window.close(); }
});

test("a deferred preparation is not recorded as an applied or predicted view", async (t) => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="card">
    <div data-native-surface data-native-surface-id="deferred-view" data-native-plugin="deferred-probe" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  t.mock.module(new URL("../host.js", import.meta.url).href, {
    namedExports: { native: true, surfaces: { kinds: ["deferred-probe"] } },
  });
  const card = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 });
  slot.getBoundingClientRect = () => ({ left: 2, top: 30, width: 196, height: 100 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "deferred-probe", surface: () => ({ module: null, composition: { kind: "view", page: "ui/page.html" } }) });
  const compositor = await import("../compositor.js?deferred-view-placement");
  compositor.setSlotSurface(slot, { surfaceId: "deferred-view", pluginId: "deferred-probe",
    composition: { kind: "view", page: "ui/page.html" } });
  let record;
  compositor.onCommit((value) => {
    record = value;
    return Promise.resolve({ placements: [], deferred: ["deferred-view"] });
  });
  const prepared = await compositor.publishAhead(new Map([["card", { x: 20, y: 0, w: 180, h: 150 }]]),
    new Map([["card", { id: "deferred-view", dim: false, inset: { left: 2, top: 30, width: 4, height: 50 } }]]));
  assert.deepEqual(prepared, [], "a deferred view was reported as a native placement");
  assert.deepEqual(record.surfaces, [], "a deferred view was stored as seated geometry");
  assert.deepEqual(record.deferred, ["deferred-view"], "the record does not hold the view that its placement deferred");
  assert.equal(compositor.seated(), record, "the answer did not settle the actual placement record");
  assert.equal(compositor.ahead(), null, "a deferred view made the predicted layout appear complete");
  assert.equal(compositor.placementPending(), false, "a completed deferred result remained pending");

  compositor.onCommit((value) => ({
    placements: value.surfaces.map((surface) => ({ id: surface.id, visible: true, scale: 2, ...surface.applied })), deferred: [],
  }));
  const drawn = await compositor.publish();
  assert.deepEqual(drawn, [{ id: "deferred-view", visible: true, scale: 2, x: 2, y: 30, w: 196, h: 100 }]);
  assert.equal(compositor.seated().surfaces.length, 1, "the drawn view did not receive its real host placement");
  assert.deepEqual(compositor.seated().deferred, [], "a placed view is held as deferred");
  dom.window.close();
});

test("a retained dormant view is validated with the host superset and projected off the compositor record", async (t) => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="visible-card">
    <div data-native-surface data-native-surface-id="visible-view" data-native-plugin="placement-superset-probe" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  t.mock.module(new URL("../host.js", import.meta.url).href, {
    namedExports: { native: true, surfaces: { kinds: ["placement-superset-probe"] } },
  });
  const card = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  card.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 });
  slot.getBoundingClientRect = () => ({ left: 2, top: 30, width: 196, height: 100 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "placement-superset-probe", surface: () => ({ module: null,
    composition: { kind: "view", page: "ui/page.html" } }) });
  const compositor = await import("../compositor.js?placement-superset-projection");
  compositor.setSlotSurface(slot, { surfaceId: "visible-view", pluginId: "placement-superset-probe",
    composition: { kind: "view", page: "ui/page.html" } });
  const { placeCompositorRecord } = compositor;
  const retainedLifecycle = { mountedSurface: () => ({ surfaceId: "tab-c2zkow", disposed: false }) };
  const dormant = {
    id: "tab-c2zkow", plugin: "placement-superset-probe", layer: 0, declared: { x: 0, y: 0, w: 0, h: 0 },
    applied: { x: 0, y: 0, w: 0, h: 0 }, visible: false, dim: false,
    surface: { composition: { kind: "view", page: "ui/page.html" } },
  };
  let record;
  let visibleRecord;
  let hostRequestIds;
  compositor.onCommit((value) => {
    record = value;
    if (value.surfaces.length) visibleRecord = { ...value, surfaces: value.surfaces.map((surface) => ({ ...surface })) };
    const hostRequest = [...value.surfaces, dormant];
    return placeCompositorRecord(value, hostRequest, (request) => {
      hostRequestIds = request.surfaces.map(({ id }) => id);
      return Promise.resolve({
        placements: request.surfaces.filter(({ id }) => id !== "tab-c2zkow")
          .map(({ id, applied }) => ({ id, visible: true, scale: 2, ...applied })),
        deferred: ["tab-c2zkow"],
      });
    }, ["placement-superset-probe"], retainedLifecycle);
  });

  const result = await compositor.publishAhead(
    new Map([["visible-card", { x: 0, y: 0, w: 200, h: 150 }]]),
    new Map([["visible-card", { id: "visible-view", dim: false, inset: { left: 2, top: 30, width: 4, height: 50 } }]]),
  );
  assert.deepEqual(hostRequestIds, ["visible-view", "tab-c2zkow"], "the host request did not include the retained dormant tab");
  assert.deepEqual(result, [{ id: "visible-view", visible: true, scale: 2, x: 2, y: 30, w: 196, h: 100 }]);
  assert.deepEqual(record.surfaces.map(({ id }) => id), ["visible-view"], "the dormant tab entered the compositor record");

  const fullRequest = [visibleRecord.surfaces[0], dormant];
  const currentPlacement = { id: "visible-view", visible: true, scale: 2, ...visibleRecord.surfaces[0].applied };
  let sentWithoutCurrent = false;
  await assert.rejects(placeCompositorRecord(visibleRecord, [dormant], () => { sentWithoutCurrent = true; },
    ["placement-superset-probe"], retainedLifecycle), /host placement request omits compositor surface visible-view/);
  assert.equal(sentWithoutCurrent, false, "an incomplete host request was sent");
  await assert.rejects(placeCompositorRecord(visibleRecord, [fullRequest[0], fullRequest[0]],
    () => { sentWithoutCurrent = true; }, ["placement-superset-probe"], retainedLifecycle), /host placement request repeats an id/);
  assert.equal(sentWithoutCurrent, false, "a host request with duplicate IDs was sent");
  await assert.rejects(placeCompositorRecord(visibleRecord, fullRequest,
    async () => ({ placements: [currentPlacement], deferred: [] }), ["placement-superset-probe"], retainedLifecycle),
  /surface placement result is missing tab-c2zkow/);
  await assert.rejects(placeCompositorRecord(visibleRecord, fullRequest,
    async () => ({ placements: [currentPlacement], deferred: ["unrequested-view"] }), ["placement-superset-probe"], retainedLifecycle),
  /surface placement cannot defer unrequested-view: id is not in the placement request/);
  await assert.rejects(placeCompositorRecord(visibleRecord, fullRequest,
    async () => ({ placements: [currentPlacement], deferred: ["tab-c2zkow", "tab-c2zkow"] }),
  ["placement-superset-probe"], retainedLifecycle), /surface placement result repeats a deferred id/);
  await assert.rejects(placeCompositorRecord(visibleRecord, fullRequest,
    async () => ({ placements: [currentPlacement, { ...currentPlacement, id: "unexpected-view" }], deferred: ["tab-c2zkow"] }),
  ["placement-superset-probe"], retainedLifecycle), /surface placement result contains unexpected id unexpected-view/);
  await assert.rejects(placeCompositorRecord(visibleRecord, fullRequest,
    async () => ({ placements: [currentPlacement, currentPlacement], deferred: ["tab-c2zkow"] }),
  ["placement-superset-probe"], retainedLifecycle), /surface placement result repeats a placement id/);
  await assert.rejects(placeCompositorRecord(visibleRecord, fullRequest,
    async () => ({ placements: [currentPlacement], deferred: ["tab-c2zkow"] }), [], retainedLifecycle),
  /surface placement cannot defer tab-c2zkow: plugin placement-superset-probe has no native surface/);
  await assert.rejects(placeCompositorRecord(visibleRecord,
    [fullRequest[0], { ...dormant, surface: { composition: { kind: "dom" } } }],
    async () => ({ placements: [currentPlacement], deferred: ["tab-c2zkow"] }), ["placement-superset-probe"], retainedLifecycle),
  /surface placement cannot defer tab-c2zkow: composition kind is dom/);
  // A drawn placement defers a view whose composition is not declared yet, as an undrawn one does (docs/spec/native-surfaces.md).
  assert.deepEqual(await placeCompositorRecord({ ...visibleRecord, drawn: true }, fullRequest,
    async () => ({ placements: [currentPlacement], deferred: ["tab-c2zkow"] }), ["placement-superset-probe"], retainedLifecycle),
  { placements: [currentPlacement], deferred: [] }, "a drawn placement refused to defer a view");

  slot.remove();
  const emptyRecordResult = await compositor.publishAhead(new Map(), new Map());
  assert.deepEqual(hostRequestIds, ["tab-c2zkow"], "the dormant-only host request changed its surface set");
  assert.deepEqual(emptyRecordResult, [], "the dormant-only host response entered the empty compositor result");
  assert.deepEqual(record.surfaces, [], "the dormant tab entered an empty compositor record");
  dom.window.close();
});

test("placement results reject missing, extra, and duplicate surfaces, and a drawn placement defers a view", async (t) => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="card">
    <div data-native-surface data-native-surface-id="contract-view" data-native-plugin="placement-contract" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  t.mock.module(new URL("../host.js", import.meta.url).href, {
    namedExports: { native: true, surfaces: { kinds: ["placement-contract"] } },
  });
  const slot = document.querySelector("[data-native-surface]");
  slot.getBoundingClientRect = () => ({ left: 1, top: 2, width: 30, height: 40 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "placement-contract", surface: () => ({ module: null,
    composition: { kind: "view", page: "ui/page.html" } }) });
  const compositor = await import("../compositor.js?placement-result-contract");
  compositor.setSlotSurface(slot, { surfaceId: "contract-view", pluginId: "placement-contract",
    composition: { kind: "view", page: "ui/page.html" } });
  compositor.onCommit(() => ({ placements: [], deferred: ["contract-view"] }));
  try {
    // A drawn placement defers a view whose composition is not declared yet (docs/spec/native-surfaces.md#view-surfaces).
    assert.doesNotThrow(() => compositor.publish(), "a drawn placement refused to defer a view");
    compositor.onCommit(() => ({ placements: [], deferred: [] }));
    assert.throws(() => compositor.publish(), /surface placement result is missing contract-view/);
    compositor.onCommit(() => ({ placements: [{ id: "unexpected" }], deferred: [] }));
    assert.throws(() => compositor.publish(), /unexpected id unexpected/);
    const duplicatePlacement = { id: "contract-view", visible: true, scale: 2, x: 1, y: 2, w: 30, h: 40 };
    compositor.onCommit(() => ({ placements: [duplicatePlacement, { ...duplicatePlacement }], deferred: [] }));
    assert.throws(() => compositor.publish(), /repeats a placement id/);
  } finally {
    dom.window.close();
  }
});

test("a visible native placement carries the scale that seated it, and the seat records that scale", async (t) => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="card">
    <div data-native-surface data-native-surface-id="scale-view" data-native-plugin="scale-contract" data-native-layer="0"></div>
  </div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  t.mock.module(new URL("../host.js", import.meta.url).href, {
    namedExports: { native: true, surfaces: { kinds: ["scale-contract"] } },
  });
  const slot = document.querySelector("[data-native-surface]");
  slot.getBoundingClientRect = () => ({ left: 1, top: 2, width: 30, height: 40 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "scale-contract", surface: () => ({ module: "probe.js", composition: { kind: "dom" } }) });
  const compositor = await import("../compositor.js?placement-scale-contract");
  compositor.setSlotSurface(slot, { surfaceId: "scale-view", pluginId: "scale-contract", composition: { kind: "dom" } });
  const placement = { id: "scale-view", visible: true, x: 1, y: 2, w: 30, h: 40 };
  try {
    compositor.onCommit(() => ({ placements: [placement], deferred: [] }));
    assert.throws(() => compositor.publish(), /surface placement result has invalid scale scale-view: undefined/);
    compositor.onCommit(() => ({ placements: [{ ...placement, scale: 0 }], deferred: [] }));
    assert.throws(() => compositor.publish(), /surface placement result has invalid scale scale-view: 0/);
    compositor.onCommit(() => ({ placements: [{ ...placement, visible: false, scale: 2 }], deferred: [] }));
    assert.throws(() => compositor.publish(), /surface placement result has a scale for hidden scale-view/);
    compositor.onCommit(() => ({ placements: [{ ...placement, scale: 2 }], deferred: [] }));
    compositor.publish();
    assert.equal(compositor.seated().surfaces[0].scale, 2, "the seat records the scale that the host fitted the surface with");
  } finally {
    dom.window.close();
  }
});

test("a preparation hides a section surface whose offsets do not fit the target card", async (t) => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="place"><div class="set">
    <div data-native-surface="view" data-native-surface-id="section" data-native-plugin="small-section-probe" data-native-layer="10"
      data-native-title="Section" data-native-dim="false"></div>
  </div></div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  t.mock.module(new URL("../host.js", import.meta.url).href, {
    namedExports: { native: true, surfaces: { kinds: ["small-section-probe"] } },
  });
  const place = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  place.getBoundingClientRect = () => ({ left: 0, top: 0, width: 196, height: 600 });
  slot.getBoundingClientRect = () => ({ left: 1, top: 33, width: 188, height: 422 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "small-section-probe", surface: () => ({ module: null, composition: { kind: "view", page: "ui/page.html" } }) });
  const compositor = await import("../compositor.js?section-small");
  const surface = { surfaceId: "section", pluginId: "small-section-probe", composition: { kind: "view", page: "ui/page.html" } };
  compositor.setSlotSurface(slot, surface);
  const records = [];
  compositor.onCommit((record) => {
    records.push(record);
    return { placements: record.surfaces.map((item) => ({ id: item.id, visible: item.visible, ...(item.visible ? { scale: 2 } : {}), ...item.applied })), deferred: [] };
  });

  compositor.publishAhead(new Map([["place", { x: 0, y: 0, w: 4, h: 100 }]]), new Map());

  const [prepared] = records;
  assert.deepEqual({ visible: prepared.surfaces[0].visible, declared: prepared.surfaces[0].declared },
    { visible: false, declared: { x: 0, y: 0, w: 0, h: 0 } },
    "a preparation sent a section surface that does not fit its target card");
  dom.window.close();
});

test("a preparation places a section surface without a box like its drawn commit, so the layout prepares once", async (t) => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="place"><div class="set" hidden>
    <div data-native-surface="view" data-native-surface-id="section" data-native-plugin="boxless-section-probe" data-native-layer="10"
      data-native-title="Section" data-native-dim="false"></div>
  </div></div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  t.mock.module(new URL("../host.js", import.meta.url).href, {
    namedExports: { native: true, surfaces: { kinds: ["boxless-section-probe"] } },
  });
  const place = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  let width = 196;
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  place.getBoundingClientRect = () => ({ left: 7, top: 83, width, height: 600 });
  slot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "boxless-section-probe", surface: () => ({ module: null, composition: { kind: "view", page: "ui/page.html" } }) });
  const compositor = await import("../compositor.js?section-boxless");
  const surface = { surfaceId: "section", pluginId: "boxless-section-probe", composition: { kind: "view", page: "ui/page.html" } };
  compositor.setSlotSurface(slot, surface);
  const records = [];
  compositor.onCommit((record) => {
    records.push(record);
    return { placements: record.surfaces.map((item) => ({ id: item.id, visible: item.visible, ...(item.visible ? { scale: 2 } : {}), ...item.applied })), deferred: [] };
  });

  compositor.publishAhead(new Map([["place", { x: 2, y: 83, w: 206, h: 600 }]]), new Map());
  width = 206;
  compositor.publish();

  const [prepared, drawn] = records;
  const placed = ({ visible, declared }) => ({ visible, declared });
  assert.deepEqual(placed(prepared.surfaces[0]), placed(drawn.surfaces[0]),
    "the preparation of a section surface without a box differs from its drawn commit, so the layout prepares twice");
  dom.window.close();
});

test("a preparation keeps a section surface at its offsets, so the drawn commit of a width change is the same request", async (t) => {
  const dom = new JSDOM(`<div id="plane"><div data-card-id="place"><div class="set">
    <div data-native-surface="view" data-native-surface-id="section" data-native-plugin="section-probe" data-native-layer="10"
      data-native-title="Section" data-native-dim="false"></div>
  </div></div></div>`, { url: "https://example.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  t.mock.module(new URL("../host.js", import.meta.url).href, {
    namedExports: { native: true, surfaces: { kinds: ["section-probe"] } },
  });
  const place = document.querySelector("[data-card-id]");
  const slot = document.querySelector("[data-native-surface]");
  let width = 196;
  document.getElementById("plane").getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  place.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 600 });
  slot.getBoundingClientRect = () => ({ left: 1, top: 33, width: width - 8, height: 422 });
  const { registerPlugin } = await import("../registry.js");
  registerPlugin({ id: "section-probe", surface: () => ({ module: null, composition: { kind: "view", page: "ui/page.html" } }) });
  const compositor = await import("../compositor.js?section-seat");
  const surface = { surfaceId: "section", pluginId: "section-probe", composition: { kind: "view", page: "ui/page.html" } };
  compositor.setSlotSurface(slot, surface);
  const records = [];
  compositor.onCommit((record) => {
    records.push(record);
    return { placements: record.surfaces.map((item) => ({ id: item.id, visible: item.visible, ...(item.visible ? { scale: 2 } : {}), ...item.applied })), deferred: [] };
  });

  compositor.publishAhead(new Map([["place", { x: 0, y: 0, w: 206, h: 600 }]]), new Map());
  width = 206;
  compositor.publish();

  const [prepared, drawn] = records;
  const placed = ({ visible, declared }) => ({ visible, declared });
  assert.deepEqual(placed(prepared.surfaces[0]), { visible: true, declared: { x: 1, y: 33, w: 198, h: 422 } },
    "the preparation did not keep the section surface at its offsets");
  assert.deepEqual(placed(prepared.surfaces[0]), placed(drawn.surfaces[0]),
    "the drawn commit differs from the preparation, so the layout prepares twice");
  dom.window.close();
});
