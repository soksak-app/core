import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createSurfaceCompositionController } from "../surface-composition.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const { window } = new JSDOM(`
    <body>
      <main id="native-parent"><div id="page"></div><div id="image"></div></main>
      <aside id="overlay-parent"><button id="toolbar"></button><button id="badge"></button></aside>
    </body>
  `, { url: "https://example.test/" });
  const callbacks = [];
  const observed = [];
  let frameCallback = null;
  let nextFrame = 0;
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; callbacks.push(callback); }
    observe(element) { observed.push(element.id || element.tagName); }
    disconnect() { this.disconnected = true; }
  };
  window.requestAnimationFrame = (callback) => {
    frameCallback = callback;
    return ++nextFrame;
  };
  window.cancelAnimationFrame = () => { frameCallback = null; };
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  window.visualViewport = { get width() { return window.innerWidth; }, get height() { return window.innerHeight; } };
  const rects = new Map();
  const element = (id, rect) => {
    const node = window.document.getElementById(id);
    rects.set(id, rect);
    node.getBoundingClientRect = () => rects.get(id);
    return node;
  };
  const page = element("page", { left: 10, top: 20, right: 310, bottom: 220, width: 300, height: 200 });
  const image = element("image", { left: 320, top: 20, right: 720, bottom: 420, width: 400, height: 400 });
  const toolbar = element("toolbar", { left: 15, top: 25, right: 115, bottom: 55, width: 100, height: 30 });
  const badge = element("badge", { left: 690, top: 30, right: 710, bottom: 50, width: 20, height: 20 });
  return {
    window, page, image, toolbar, badge, callbacks, observed,
    setRect: (id, rect) => rects.set(id, rect),
    resize: () => { for (const callback of callbacks) callback([]); },
    frame: () => {
      const callback = frameCallback;
      frameCallback = null;
      callback?.();
    },
  };
}

function runtime({ documentAttach, imageAttach, place } = {}) {
  const documentCalls = [];
  const imageCalls = [];
  const placements = [];
  const document = {
    attach: (name) => {
      documentCalls.push(["attach", name]);
      return documentAttach ? documentAttach(name) : Promise.resolve();
    },
    place: (...args) => { documentCalls.push(["place", ...args]); return Promise.resolve(); },
    load: (...args) => { documentCalls.push(["load", ...args]); return Promise.resolve(); },
    go: (...args) => { documentCalls.push(["go", ...args]); return Promise.resolve(true); },
    detach: (name) => { documentCalls.push(["detach", name]); return Promise.resolve(); },
    onState: () => Promise.resolve(() => {}),
    post: (...args) => { documentCalls.push(["post", ...args]); return Promise.resolve(); },
    onMessage: () => Promise.resolve(() => {}),
  };
  const image = {
    attach: (name, sidecar) => {
      imageCalls.push(["attach", name, sidecar]);
      return imageAttach ? imageAttach(name, sidecar) : Promise.resolve();
    },
    place: (...args) => { imageCalls.push(["place", ...args]); return Promise.resolve(); },
    focus: (...args) => { imageCalls.push(["focus", ...args]); return Promise.resolve(); },
    caret: (...args) => { imageCalls.push(["caret", ...args]); return Promise.resolve(); },
    text: (...args) => { imageCalls.push(["text", ...args]); return Promise.resolve(); },
    detach: (name) => { imageCalls.push(["detach", name]); return Promise.resolve(); },
    on: () => Promise.resolve(() => {}),
  };
  return {
    page: {
      document,
      image,
      composition: {
        place: async (revision, regions, overlays) => {
          placements.push(structuredClone({ revision, regions, overlays }));
          if (place) return place(revision, regions, overlays);
        },
      },
      surfaces: { report: () => {} },
    },
    documentCalls,
    imageCalls,
    placements,
  };
}

test("DOM composition does not declare or place a native surface", async () => {
  const { window } = new JSDOM("<body><main></main></body>", { url: "https://example.test/" });
  const calls = [];
  const composition = await createSurfaceCompositionController(
    {
      composition: {
        declare: () => { calls.push("declare"); return Promise.resolve(); },
        place: () => { calls.push("place"); return Promise.resolve(); },
      },
      surfaces: { report: () => {} },
    },
    { kind: "dom" },
    { regions: {}, overlays: {} },
    window,
    window.document.querySelector("main"),
  );
  await composition.update(() => {});
  await composition.dispose();
  assert.deepEqual(calls, []);
  window.close();
});

const declaration = {
  kind: "hybrid",
  regions: [
    { name: "page", kind: "document", input: "native" },
    { name: "image", kind: "image", input: "dom", sidecar: "renderer" },
  ],
  overlays: ["toolbar", "badge"],
};

test("creation attaches declared regions and submits one complete ordered snapshot", async () => {
  const f = fixture();
  const r = runtime();
  const composition = await createSurfaceCompositionController(r.page, declaration, {
    regions: { image: f.image, page: f.page },
    overlays: { badge: f.badge, toolbar: f.toolbar },
  }, f.window);

  assert.equal(composition.kind, "hybrid");
  assert.deepEqual(r.documentCalls, [["attach", "page"]]);
  assert.deepEqual(r.imageCalls, [["attach", "image", "renderer"]]);
  assert.deepEqual(r.placements, [{
    revision: 1,
    regions: [
      { name: "page", left: 10, top: 20, right: 490, bottom: 380, visible: true },
      { name: "image", left: 320, top: 20, right: 80, bottom: 180, visible: true },
    ],
    overlays: [
      { name: "toolbar", left: 15, top: 25, right: 685, bottom: 545, visible: true },
      { name: "badge", left: 690, top: 30, right: 90, bottom: 550, visible: true },
    ],
  }]);
  assert.equal(f.window.document.documentElement.dataset.surfaceComposition, "hybrid");
  assert.equal(f.page.style.getPropertyValue("opacity"), "0");
  assert.equal(f.page.style.getPropertyPriority("opacity"), "important");
  assert.equal(f.image.style.getPropertyValue("pointer-events"), "auto");
  assert.equal(f.image.style.getPropertyPriority("pointer-events"), "important");
  assert.equal(f.toolbar.style.getPropertyValue("pointer-events"), "auto");
  assert.equal(f.toolbar.style.getPropertyValue("contain"), "paint");
  assert.equal(f.toolbar.style.getPropertyPriority("contain"), "important");
  assert.equal(f.window.document.getElementById("native-parent").style.getPropertyValue("background-color"), "transparent");
  assert.equal(f.window.document.getElementById("native-parent").style.getPropertyPriority("background-color"), "important");
  assert.equal(f.window.document.getElementById("overlay-parent").style.getPropertyValue("background-color"), "");
  assert.equal(Object.hasOwn(composition.region("page"), "focus"), false);
  assert.equal(Object.hasOwn(composition.region("image"), "load"), false);
});

test("the hybrid paint boundary restores native-anchor and ancestor transparency", async () => {
  const f = fixture();
  const r = runtime();
  await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  const parent = f.window.document.getElementById("native-parent");
  f.page.style.setProperty("opacity", "1", "important");
  parent.style.setProperty("background-color", "white", "important");
  f.window.document.documentElement.removeAttribute("data-soksak-native-ancestor");
  await settle();

  assert.equal(f.page.style.getPropertyValue("opacity"), "0");
  assert.equal(f.page.style.getPropertyPriority("opacity"), "important");
  assert.equal(parent.style.getPropertyValue("background-color"), "transparent");
  assert.equal(parent.style.getPropertyPriority("background-color"), "important");
  assert.match(f.window.document.documentElement.getAttribute("data-soksak-native-ancestor"), /^composition-/);
});

test("multiple hybrid surfaces share one document paint-boundary token without an observer loop", async () => {
  const f = fixture();
  const r = runtime();
  const first = await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  const second = await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  f.page.style.setProperty("opacity", "1", "important");
  await Promise.race([
    settle(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("paint-boundary observer loop")), 200)),
  ]);
  assert.equal(f.page.style.getPropertyValue("opacity"), "0");
  await second.dispose();
  assert.match(f.page.getAttribute("data-soksak-native-anchor"), /^composition-/);
  assert.equal(f.page.style.getPropertyValue("opacity"), "0");
  await first.dispose();
  assert.equal(f.page.hasAttribute("data-soksak-native-anchor"), false);
});

test("an observed overlay change submits every region and overlay through composition.place", async () => {
  const f = fixture();
  const r = runtime();
  await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  r.placements.length = 0;
  f.setRect("toolbar", { left: 25, top: 35, right: 145, bottom: 75, width: 120, height: 40 });
  f.resize();
  await settle();

  assert.equal(r.placements.length, 1);
  assert.equal(r.placements[0].revision, 2);
  assert.deepEqual(r.placements[0].regions.map(({ name }) => name), ["page", "image"]);
  assert.deepEqual(r.placements[0].overlays.map(({ name }) => name), ["toolbar", "badge"]);
  assert.deepEqual(r.placements[0].overlays[0], {
    name: "toolbar", left: 25, top: 35, right: 655, bottom: 525, visible: true,
  });
  assert.equal(r.documentCalls.some(([operation]) => operation === "place"), false);
  assert.equal(r.imageCalls.some(([operation]) => operation === "place"), false);
  // 관찰은 다음 animation frame 에 시작한다.
  f.frame();
  assert(f.observed.includes("toolbar"), "the overlay itself is observed");
  assert(f.observed.includes("overlay-parent"), "the overlay ancestor is observed");
});

test("a same-size move caught by an observer still submits a complete snapshot", async () => {
  const f = fixture();
  const r = runtime();
  await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  r.placements.length = 0;
  f.setRect("page", { left: 40, top: 20, right: 340, bottom: 220, width: 300, height: 200 });
  f.resize();
  await settle();

  assert.equal(r.placements.length, 1);
  assert.equal(r.placements[0].revision, 2);
  assert.equal(r.placements[0].regions[0].left, 40);
  assert.deepEqual(r.placements[0].regions.map(({ name }) => name), ["page", "image"]);
  assert.deepEqual(r.placements[0].overlays.map(({ name }) => name), ["toolbar", "badge"]);
});

test("a size change with unchanged insets still submits a new full snapshot", async () => {
  const f = fixture();
  const r = runtime();
  await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  r.placements.length = 0;
  Object.defineProperty(f.window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(f.window, "innerHeight", { value: 800, configurable: true });
  f.setRect("page", { left: 10, top: 20, right: 510, bottom: 420, width: 500, height: 400 });
  f.resize();
  await settle();

  assert.equal(r.placements.length, 1);
  assert.deepEqual(r.placements[0].regions[0], {
    name: "page", left: 10, top: 20, right: 490, bottom: 380, visible: true,
  });
});

test("a failed placement does not poison the next higher complete revision", async () => {
  const f = fixture();
  const r = runtime({ place: (revision) => {
    if (revision === 2) return Promise.reject(new Error("revision 2 rejected"));
  } });
  const composition = await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(composition.update(() => {
      f.setRect("page", { left: 20, top: 20, right: 320, bottom: 220, width: 300, height: 200 });
    }), /revision 2 rejected/);
    await composition.update(() => {
      f.setRect("page", { left: 30, top: 20, right: 330, bottom: 220, width: 300, height: 200 });
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(r.placements.map(({ revision }) => revision), [1, 2, 3]);
  assert.equal(r.placements[2].regions[0].left, 30);
});

test("disposal waits for an in-flight placement before detaching regions", async () => {
  const f = fixture();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const r = runtime({ place: (revision) => revision === 2 ? blocked : undefined });
  const composition = await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  const update = composition.update(() => {
    f.setRect("page", { left: 20, top: 20, right: 320, bottom: 220, width: 300, height: 200 });
  });
  await settle();
  assert.equal(r.placements.at(-1).revision, 2);

  const queued = composition.update(() => {
    f.setRect("page", { left: 30, top: 20, right: 330, bottom: 220, width: 300, height: 200 });
  });

  let disposed = false;
  const closing = composition.dispose().then(() => { disposed = true; });
  await settle();
  assert.equal(disposed, false, "disposal must wait for the placement already in flight");
  assert.equal(r.imageCalls.some(([operation]) => operation === "detach"), false,
    "native regions must stay attached until placement settles");

  release();
  await update;
  await assert.rejects(queued, /surface composition is inactive/);
  await closing;
  console.error = originalError;
  assert.equal(disposed, true);
  assert.equal(r.imageCalls.some(([operation]) => operation === "detach"), true);
  assert.deepEqual(errors, [], "disposing an in-flight placement must not report an expected inactive-surface cancellation");
});

test("an attachment failure rolls back successful attachments and the DOM mode marker", async () => {
  const f = fixture();
  f.window.document.documentElement.dataset.surfaceComposition = "previous";
  f.page.style.setProperty("opacity", "0.7");
  const parent = f.window.document.getElementById("native-parent");
  parent.style.setProperty("background-color", "red");
  const r = runtime({ imageAttach: () => Promise.reject(new Error("image attach failed")) });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(createSurfaceCompositionController(r.page, declaration, {
      regions: { page: f.page, image: f.image },
      overlays: { toolbar: f.toolbar, badge: f.badge },
    }, f.window), /image attach failed/);
  } finally {
    console.error = originalError;
  }
  assert(r.documentCalls.some(([operation, name]) => operation === "detach" && name === "page"));
  assert.equal(r.placements.length, 0);
  assert.equal(f.window.document.documentElement.dataset.surfaceComposition, "previous");
  assert.equal(f.page.style.getPropertyValue("opacity"), "0.7");
  assert.equal(f.page.style.getPropertyPriority("opacity"), "");
  assert.equal(parent.style.getPropertyValue("background-color"), "red");
  assert.equal(parent.style.getPropertyPriority("background-color"), "");
  assert.equal(f.page.hasAttribute("data-soksak-native-anchor"), false);
});

test("an initial snapshot failure detaches every attached region", async () => {
  const f = fixture();
  const r = runtime({ place: () => Promise.reject(new Error("initial snapshot failed")) });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(createSurfaceCompositionController(r.page, declaration, {
      regions: { page: f.page, image: f.image },
      overlays: { toolbar: f.toolbar, badge: f.badge },
    }, f.window), /initial snapshot failed/);
  } finally {
    console.error = originalError;
  }
  assert(r.documentCalls.some(([operation]) => operation === "detach"));
  assert(r.imageCalls.some(([operation]) => operation === "detach"));
  assert.equal(f.window.document.documentElement.dataset.surfaceComposition, undefined);
});

test("declaration keys and document ownership are validated before attachment", async () => {
  const f = fixture();
  const r = runtime();
  await assert.rejects(createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page }, overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window), /composition regions must exactly match/);
  const foreign = new JSDOM("<div id=foreign></div>").window.document.getElementById("foreign");
  await assert.rejects(createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: foreign }, overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window), /must be an element in this document/);
  f.page.append(f.toolbar);
  await assert.rejects(createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image }, overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window), /overlays and native anchors cannot contain each other/);
  assert.deepEqual(r.documentCalls, []);
  assert.deepEqual(r.imageCalls, []);
});

test("a shadow-root composition scopes the marker and measures from its viewport host", async () => {
  const { window } = new JSDOM("<body><main id=outside></main></body>", { url: "https://example.test/" });
  const plane = window.document.createElement("main");
  plane.className = "plane";
  const card = window.document.createElement("article");
  const slot = window.document.createElement("div");
  const host = window.document.createElement("section");
  host.id = "surface-host";
  window.document.body.append(plane);
  plane.append(card);
  card.append(slot);
  slot.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const page = window.document.createElement("div");
  const overlay = window.document.createElement("button");
  shadow.append(page, overlay);
  const observed = [];
  window.ResizeObserver = class {
    constructor() {}
    observe(element) { observed.push(element); }
    disconnect() {}
  };
  const frames = [];
  window.requestAnimationFrame = (callback) => frames.push(callback);
  window.cancelAnimationFrame = () => {};
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
  window.visualViewport = { get width() { return window.innerWidth; }, get height() { return window.innerHeight; } };
  slot.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300 });
  host.getBoundingClientRect = () => slot.getBoundingClientRect();
  page.getBoundingClientRect = () => ({ left: 110, top: 70, right: 410, bottom: 170, width: 300, height: 100 });
  overlay.getBoundingClientRect = () => ({ left: 120, top: 80, right: 180, bottom: 100, width: 60, height: 20 });
  const r = runtime();
  const composition = await createSurfaceCompositionController(r.page, {
    kind: "hybrid",
    regions: [{ name: "page", kind: "document", input: "native" }],
    overlays: ["overlay"],
  }, { regions: { page }, overlays: { overlay } }, window, slot);

  assert.equal(window.document.documentElement.dataset.surfaceComposition, undefined);
  assert.equal(slot.dataset.surfaceComposition, "hybrid");
  assert.equal(window.document.body.style.getPropertyValue("background-color"), "");
  assert.deepEqual(r.placements[0].regions, [{ name: "page", left: 10, top: 20, right: 90, bottom: 180, visible: true }]);
  assert.deepEqual(r.placements[0].overlays, [{ name: "overlay", left: 20, top: 30, right: 320, bottom: 250, visible: true }]);
  // 관찰은 다음 animation frame 에 시작한다.
  for (const frame of frames.splice(0)) frame();
  assert(observed.includes(slot), "the surface slot is observed for size changes");
  assert.equal(host.style.getPropertyValue("background-color"), "transparent");
  assert.equal(host.style.getPropertyPriority("background-color"), "important");
  assert.equal(card.style.getPropertyValue("background-color"), "transparent");
  assert.equal(plane.style.getPropertyValue("background-color"), "transparent");
  await composition.update(() => {});
});

test("the document region handle loads a session history entry by its offset", async () => {
  const f = fixture();
  const r = runtime();
  const composition = await createSurfaceCompositionController(r.page, declaration, {
    regions: { image: f.image, page: f.page },
    overlays: { badge: f.badge, toolbar: f.toolbar },
  }, f.window);
  assert.equal(await composition.region("page").entry(-1), true);
  assert.deepEqual(r.documentCalls.at(-1), ["go", "page", "entry", -1]);
  await composition.dispose();
});

test("the controller starts observing at the next animation frame, before that frame's observation round", async () => {
  // 관찰 round 도중에 시작한 관찰은 이미 지나간 깊이의 첫 관찰을 다음 frame 으로 미루고 WebKit 은 그때
  // ResizeObserver loop 오류를 낸다. animation frame 은 그 frame 의 관찰 round 보다 먼저 실행된다(F32).
  const f = fixture();
  const r = runtime();
  await createSurfaceCompositionController(r.page, declaration, {
    regions: { page: f.page, image: f.image },
    overlays: { toolbar: f.toolbar, badge: f.badge },
  }, f.window);
  assert.deepEqual(f.observed, [], "an element was observed before the next animation frame");
  f.frame();
  assert(f.observed.includes("page") && f.observed.includes("toolbar") && f.observed.includes("overlay-parent"),
    `the regions, overlays and their ancestors are observed after the frame: ${f.observed}`);
});
