import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";
import { setSurfaceTextSize } from "../text-size.js";

setSurfaceTextSize(() => 1);

// A place that leaves a surface out removes the composition of that surface in the host (docs/spec/native-surfaces.md), and
// the page releases the surface only after the place replies. A geometry change in between, such as the layout change that
// the place itself makes, must not send a composition place of that surface, which the host refuses with
// `surface "<id>" has no composition declaration`. A failed place resumes the composition, which places its geometry again.
test("a surface that a place leaves out sends no composition place while the place runs", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  // Animation frames run at once, so the observation starts at the mount and a resize places at once.
  dom.window.requestAnimationFrame = (fn) => { fn(0); return 1; };
  dom.window.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const calls = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name) => {
        calls.push(name);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, placeSurfaces } = await import("../surface-modules.js?place-left-out");
  const pluginId = "fixture-place-left-out";
  const surfaceId = "fixture-place-left-out-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    return { dispose: () => composition.dispose() };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: [],
    composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    const placing = (result) => async () => {
      const before = calls.length;
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      during.push(...calls.slice(before));
      if (result instanceof Error) throw result;
      return result;
    };
    const during = [];
    // A failed place sends nothing while it runs and resumes the composition after it.
    const start = calls.length;
    await assert.rejects(placeSurfaces(placing(new Error("host.place refused the layout")), { retain: new Set(), unload: [] }),
      /host.place refused the layout/);
    assert.deepEqual(during.filter((name) => name === "compositionPlace"), [],
      `host calls while the failed place that leaves the surface out runs: ${JSON.stringify(during)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.slice(start).filter((name) => name === "compositionPlace"), ["compositionPlace"],
      `the composition did not place once again after the failed place: ${JSON.stringify(calls.slice(start))}`);
    during.length = 0;
    assert.equal(await placeSurfaces(placing("placed"), { retain: new Set(), unload: [] }), "placed");
    assert.deepEqual(during.filter((name) => name === "compositionPlace"), [],
      `host calls while the place that leaves the surface out runs: ${JSON.stringify(during)}`);
  } finally {
    dom.window.close();
  }
});

// The place ends the sidecar sessions of a surface that it leaves out in the host. A send of the module after that, such as the
// end of the session that its dispose sends, would open a session in the host without a project root, which the next retain of
// the sidecar refuses (`retain surface entry is invalid`). A send while a failed place runs is sent after it.
test("a surface that a place leaves out sends nothing to its sidecar after the place ends its sessions", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=slot></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const sent = [];
  globalThis.surfacePlaceSidecar = null;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async () => null },
        sidecar: () => ({ send: async (id, body) => { sent.push(body.op); return null; }, on: () => () => {} }) };
    },
  } });
  const { mountSurface, authorizeSurface, placeSurfaces, mountedSurface } = await import("../surface-modules.js?place-left-out-sidecar");
  const pluginId = "fixture-place-left-out-sidecar";
  const surfaceId = "fixture-place-left-out-sidecar-surface";
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    const port = context.runtime.sidecar();
    globalThis.surfacePlaceSidecar = (op) => port.send(context.surfaceId, { op });
    return { dispose: () => port.send(context.surfaceId, { op: "end" }) };
  }`)}`;
  const surface = { module, surfaceId, pluginId, declarations: { status: [], commands: [], dom: [] }, sidecars: ["fixture-sidecar"],
    composition: { kind: "dom" } };
  try {
    authorizeSurface(surfaceId);
    await mountSurface(document.querySelector("#slot"), surface);
    // A send while a failed place runs waits and is sent after it.
    let during;
    await assert.rejects(placeSurfaces(async () => {
      during = globalThis.surfacePlaceSidecar("input");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(sent, [], "a sidecar send left while the place ran");
      throw new Error("host.place refused the layout");
    }, { retain: new Set(), unload: [] }), /host.place refused the layout/);
    await during;
    assert.deepEqual(sent, ["input"]);
    // After a place that succeeds, the dispose of the module sends nothing.
    assert.equal(await placeSurfaces(async () => "placed", { retain: new Set(), unload: [] }), "placed");
    assert.equal(mountedSurface(surfaceId), null);
    assert.deepEqual(sent, ["input"], `sidecar sends after the place ended the sessions: ${JSON.stringify(sent)}`);
  } finally {
    delete globalThis.surfacePlaceSidecar;
    dom.window.close();
  }
});

// A failed place resumes the composition of every surface it left out. A resume that fails is part of the failure of the place:
// the error that the caller reports names the place and the resume, and the other compositions still resume.
test("a failed place reports a composition that does not resume and resumes the others", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<main><div id=a></div><div id=b></div></main>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  dom.window.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  Object.defineProperty(dom.window, "visualViewport", { value: { width: 800, height: 600 } });
  const placed = [];
  let refuse = false;
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: {
    ...actualHost,
    native: true,
    onSurfacePrepared: () => () => {},
    surfaceContextRuntime: (surface, declarations) => {
      const runtime = actualHost.surfaceContextRuntime(surface, declarations);
      return { ...runtime, native: { ...runtime.native, on: () => () => {}, call: async (name) => {
        if (name !== "compositionPlace") return null;
        if (refuse && surface.surfaceId.endsWith("-a")) throw new Error(`surface "${surface.surfaceId}" refused the placement`);
        placed.push(surface.surfaceId);
        return null;
      } } };
    },
  } });
  const { mountSurface, authorizeSurface, placeSurfaces } = await import("../surface-modules.js?place-left-out-resume");
  const pluginId = "fixture-place-left-out-resume";
  registerPlugin({ id: pluginId, surface: () => null });
  const module = `data:text/javascript,${encodeURIComponent(`export async function mount(root, context) {
    root.innerHTML = "<div id=view></div>";
    const composition = await context.composition.create({ regions: { view: root.querySelector("#view") } });
    return { dispose: () => composition.dispose() };
  }`)}`;
  const surfaceOf = (id) => ({ module, surfaceId: `fixture-resume-${id}`, pluginId, declarations: { status: [], commands: [], dom: [] },
    sidecars: [], composition: { kind: "hybrid", regions: [{ name: "view", kind: "image", sidecar: "fixture-sidecar", input: "dom" }],
      overlays: [] } });
  try {
    for (const id of ["a", "b"]) {
      authorizeSurface(`fixture-resume-${id}`);
      await mountSurface(document.querySelector(`#${id}`), surfaceOf(id));
    }
    placed.length = 0;
    refuse = true;
    const error = await placeSurfaces(async () => { throw new Error("host.place refused the layout"); }, { retain: new Set(), unload: [] })
      .then(() => null, (failure) => failure);
    assert.ok(error, "the failed place resolved");
    assert.match(error.message, /host\.place refused the layout/);
    assert.match(error.message, /1 compositions did not resume/);
    assert.ok(error instanceof AggregateError, `the error is ${error}`);
    assert.deepEqual(error.errors.map((item) => item.message),
      ["host.place refused the layout", `surface "fixture-resume-a" refused the placement`]);
    assert.deepEqual(placed, ["fixture-resume-b"], `compositions that resumed: ${JSON.stringify(placed)}`);
  } finally {
    dom.window.close();
  }
});
