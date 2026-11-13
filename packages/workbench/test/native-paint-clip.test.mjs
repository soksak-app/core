import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

// The host module reads the host when it is first imported, so each fixture selects the case before it imports the compositor.
// The paint of the holes sends no host call: each commit is answered by the test (compositor.onCommit), so the case has no steps.

/** A placement as the host answers it: a visible surface names the backing scale whose device pixels it was fitted to. */
const seatedAt = (placement) => (placement.visible === true ? { ...placement, scale: 2 } : placement);

async function fixture(name) {
  const wire = selectPageWire("native-paint-clip-none");
  const dom = new JSDOM('<div id="plane"><div data-card-id="card"><div data-native-surface data-native-surface-id="surface" data-native-plugin="probe" data-native-layer="0"></div></div></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const callbacks = [];
  globalThis.requestAnimationFrame = (callback) => callbacks.push(callback);
  const plane = document.getElementById("plane");
  const slot = document.querySelector("[data-native-surface]");
  plane.getBoundingClientRect = () => ({ left: 10, top: 5, width: 400, height: 200 });
  let width = 200;
  slot.getBoundingClientRect = () => ({ left: 20, top: 25, width, height: 100 });
  // The kinds that the application draws are the registered plugins; the probe plugin of the surfaces is registered once.
  const { registerPlugin, surfacePlugins } = await import("../registry.js");
  if (!surfacePlugins().includes("probe")) {
    registerPlugin({ id: "probe", name: "Probe", mark: "p", svg: "<path/>", ink: null, drop: null, background: null, surface: () => null });
  }
  const compositor = await import(`../compositor.js?paint-clip-${name}`);
  compositor.setSlotSurface(slot, { surfaceId: "surface", pluginId: "probe", composition: { kind: "dom" } });
  const requests = [];
  // When unsent is true, the next commit has no reply, as if it were the same as the previous request and was not sent to the host (same as host.js).
  const state = { unsent: false };
  compositor.onCommit((record) => {
    if (state.unsent) { state.unsent = false; return undefined; }
    return new Promise(resolve => requests.push({ record, resolve }));
  });
  const answer = (placement = {}) => {
    const request = requests.shift();
    assert.ok(request, "no pending host placement");
    request.resolve({
      placements: request.record.surfaces.map(surface => seatedAt({ id: surface.id, visible: surface.visible, ...surface.applied, ...placement })),
      deferred: [],
    });
  };
  const frame = () => { for (const callback of callbacks.splice(0)) callback(); };
  const clip = () => document.head.querySelector("style")?.textContent ?? null;
  return { dom, wire, compositor, requests, callbacks, answer, frame, clip, state, resize: next => { width = next; } };
}

test("native preparation does not change the presented background holes", async () => {
  const f = await fixture("preparation");
  try {
    const initial = f.compositor.publish();
    f.answer(); await initial; f.frame();
    const before = f.clip();
    const prepared = f.compositor.publishAhead(new Map([["card", { x: 10, y: 20, w: 180, h: 100 }]]),
      new Map([["card", { id: "surface", dim: false, inset: { left: 0, top: 0, width: 0, height: 0 } }]]));
    assert.equal(f.requests[0].record.drawn, false);
    f.answer(); await prepared;
    f.resize(180);
    assert.equal(f.callbacks.length, 0, "preparation scheduled a paint-hole update before presentation");
    f.frame();
    assert.equal(f.clip(), before, "preparation replaced the presented background holes");
  } finally { f.dom.window.close(); f.wire.finish(); }
});

test("a deferred paint update uses the acknowledged layout instead of a newer pending DOM", async () => {
  const f = await fixture("pending-dom");
  try {
    const initial = f.compositor.publish();
    f.answer(); await initial;
    assert.equal(f.clip(), null, "presentation must retain its animation-frame delay");
    f.resize(180);
    const pending = f.compositor.publish();
    f.frame();
    assert.match(f.clip(), /M20,25v100h200v-100Z/, "a pending DOM replaced the acknowledged native rectangle");
    f.answer(); await pending; f.frame();
    assert.match(f.clip(), /M20,25v100h180v-100Z/);
  } finally { f.dom.window.close(); f.wire.finish(); }
});

test("paint holes retain acknowledged native alignment and visibility", async () => {
  const f = await fixture("native-alignment");
  try {
    const initial = f.compositor.publish();
    f.answer({ x: 10.5, y: 20.5, w: 199.5, h: 99.5 }); await initial; f.frame();
    assert.match(f.clip(), /M20.5,25.5v99.5h199.5v-99.5Z/);
    const hidden = f.compositor.publish();
    f.answer({ visible: false }); await hidden; f.frame();
    assert.equal(f.clip(), `body::before{clip-path:path("M0,0H${window.innerWidth}V${window.innerHeight}H0Z")}`);
  } finally { f.dom.window.close(); f.wire.finish(); }
});

for (const [index, [value, error]] of [
  [null, /surface placement result is missing surface/],
  [{ visible: undefined }, /surface placement result has invalid visibility surface/],
  [{ w: NaN }, /surface placement result has invalid geometry surface/],
].entries()) {
  test(`native paint acknowledgement rejects invalid reply ${index}`, async () => {
    const f = await fixture(`invalid-${index}`);
    try {
      const pending = f.compositor.publish();
      if (value === null) f.requests.shift().resolve({ placements: [], deferred: [] });
      else f.answer(value);
      await assert.rejects(pending, error);
      assert.equal(f.callbacks.length, 0, "invalid acknowledgement scheduled a paint update");
    } finally { f.dom.window.close(); f.wire.finish(); }
  });
}

test("a placement answer that arrives after a newer one does not replace the newer background holes", async () => {
  const f = await fixture("order");
  try {
    // Sends the layout during the drag (width 160) and the layout after the drag (width 200). Under load, the reply of the earlier layout arrives later than the reply of the later layout.
    f.resize(160);
    const older = f.compositor.publish();
    f.resize(200);
    const newer = f.compositor.publish();
    assert.equal(f.requests.length, 2);
    const [first, second] = f.requests.splice(0);
    second.resolve({
      placements: second.record.surfaces.map(surface => seatedAt({ id: surface.id, visible: surface.visible, ...surface.applied })),
      deferred: [],
    });
    await newer; f.frame();
    const latest = f.clip();
    first.resolve({
      placements: first.record.surfaces.map(surface => seatedAt({ id: surface.id, visible: surface.visible, ...surface.applied })),
      deferred: [],
    });
    await older; f.frame();
    assert.equal(f.clip(), latest, "an older placement answer replaced the background holes of the newer placement");
  } finally { f.dom.window.close(); f.wire.finish(); }
});

test("a drawn commit equal to the prepared placement writes the holes of that placement", async () => {
  const f = await fixture("unsent");
  try {
    // The drawn layout during the drag (width 160) uses the clip.
    f.resize(160);
    const dragged = f.compositor.publish();
    f.answer(); await dragged; f.frame();
    const during = f.clip();
    // The prepared layout after the drag (width 200) is before drawing, so it does not use the clip.
    const prepared = f.compositor.publishAhead(new Map([["card", { x: 10, y: 20, w: 200, h: 100 }]]),
      new Map([["card", { id: "surface", dim: false, inset: { left: 0, top: 0, width: 0, height: 0 } }]]));
    f.answer(); await prepared; f.frame();
    // The commit after drawing is the same as the preparation request, so it is not sent. The prepared layout is what the screen shows, so the clip must follow that layout too.
    f.resize(200);
    f.state.unsent = true;
    f.compositor.publish();
    f.frame();
    assert.notEqual(f.clip(), during, "the clip kept the holes of the drag placement after the prepared placement was drawn");
    assert.match(f.clip(), /h200/, `the clip does not cut the drawn 200-point surface: ${f.clip()}`);
  } finally { f.dom.window.close(); f.wire.finish(); }
});


test("during a run the next drawn commit writes the acknowledged holes without an animation frame", async () => {
  const f = await fixture("run");
  const divider = document.createElement("div");
  divider.className = "sp-divider";
  divider.dataset.dragging = "true";
  document.getElementById("plane").appendChild(divider);
  try {
    const first = f.compositor.publish();
    f.answer(); await first;
    // An animation frame starts a rendering update of the main document, and its layer commit can still be in flight when the next draw of the run asks for its presentation.
    assert.equal(f.callbacks.length, 0, "a presentation during a run requested an animation frame");
    assert.equal(f.clip(), null, "a presentation wrote its holes before a later draw");
    f.resize(180);
    const second = f.compositor.publish();
    assert.match(f.clip(), /M20,25v100h200v-100Z/, `the next drawn commit of the run did not write the acknowledged holes: ${f.clip()}`);
    delete divider.dataset.dragging;
    const last = f.compositor.publish();
    f.answer(); await second;
    f.answer(); await last;
    assert.equal(f.callbacks.length, 1, "the end of the run did not request one animation frame for the acknowledged holes");
    f.frame();
    assert.match(f.clip(), /M20,25v100h180v-100Z/, `the end of the run did not write the holes of the last presentation: ${f.clip()}`);
  } finally { divider.remove(); f.dom.window.close(); f.wire.finish(); }
});
