// A preparation holds the title bar height, and the page reads the window button region of the preparation whose presentation it confirmed as the committed state. No call
// requests the title bar separately after drawing (docs/spec/native-surfaces.md#title-bar-height).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { clockAnswer, recordsOf } from "./support/records.mjs";
const emptySurfaceDeclarations = { status: [], commands: [], element: [] };

test("a view surface carries its start values in the preparation and a surface without them carries none", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: () => ({ surfaceId: "view" }),
    compositionState: () => ({ state: "declared" }),
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") {
        return { ticket: 1, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?start");
  const start = {
    params: { path: "a.md" },
    origin: { directory: "/work/one" },
    project: { root: "/work/one" },
    declarations: { commands: [] },
  };
  const record = {
    surfaces: [
      { id: "view", dim: false, visible: true,
        surface: { module: null, pluginId: "probe", composition: { kind: "view", page: "ui/page.html" },
          params: { path: "a.md" }, declarations: { commands: [] } },
        applied: { x: 0, y: 0, w: 3, h: 4 }, start },
      { id: "dom", dim: false, visible: true,
        surface: { module: "surface-module", pluginId: "other", composition: { kind: "dom" } },
        applied: { x: 0, y: 4, w: 3, h: 4 } },
    ],
    settled: true, drawn: false, titlebar: 40,
  };
  try {
    await surfaces.theme({ scheme: "dark", tokens: { "--bg": "#000" } });
    calls.length = 0;
    await surfaces.place(record);
    assert.equal(calls[0].request.surfaces[0].start.declarations, 0);
    assert.deepEqual(calls[0].request.declarations, [start.declarations]);
    assert.deepEqual({ params: calls[0].request.surfaces[0].start.params,
      origin: calls[0].request.surfaces[0].start.origin, project: calls[0].request.surfaces[0].start.project },
    { params: start.params, origin: start.origin, project: start.project });
    assert.equal("start" in calls[0].request.surfaces[1], false);
  } finally {
    dom.window.close();
  }
});

test("the preparation carries the title bar height and the presented chrome is the committed one", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let prepared = 0;
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "syncSurfaces") {
        prepared++;
        return {
          ticket: prepared,
          placements: [{ id: "surface", x: 1, y: 2, w: 3, h: 4, visible: true, scale: 2 }],
          // The window button region that the host read after it set the title bar inside the transaction: the 14 pt buttons are centered in the row.
          chrome: { controls: { x: 13, y: (request.titlebar - 14) / 2, w: 54, h: 14 }, row: request.titlebar },
        };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { chrome, surfaces } = await import("../host.js");
  const record = (titlebar, drawn, viewport = { width: 800, height: 600 }) => ({
    surfaces: [{
      id: "surface", dim: false, visible: true,
      surface: { module: "surface-module", composition: { kind: "dom" } },
      applied: { x: 1, y: 2, w: 3, h: 4 },
    }],
    settled: true, drawn, titlebar, viewport,
  });
  try {
    assert.equal("titlebar" in chrome, false, "the page has no title bar request apart from the preparation");
    assert.equal(chrome.presented(), null, "no preparation has been presented");

    const prepared = await surfaces.place(record(54, false));
    assert.deepEqual(prepared.placements, [{ id: "surface", visible: true, scale: 2, x: 1, y: 2, w: 3, h: 4 }],
      "the answer keeps the scale whose device pixels the host fitted the surface to");
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces"]);
    assert.equal(calls[0].request.titlebar, 54, "the preparation carries the row of the next draw");
    assert.deepEqual(calls[0].request.viewport, { width: 800, height: 600 }, "the preparation carries the viewport of its layout");
    assert.deepEqual(calls[0].request.declarations, [], "a request without views must carry its empty declaration table");
    assert.equal(chrome.presented(), null, "a preparation is not the committed state before its presentation");

    await surfaces.place(record(54, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "the draw makes no request other than the presentation");
    assert.deepEqual(Object.keys(calls[1].request).sort(), ["placements", "settled", "ticket"],
      "the presentation sends the prepared ticket and placements");
    assert.deepEqual(chrome.presented(), { controls: { x: 13, y: 20, w: 54, h: 14 }, row: 54 });

    // The preparation of the next layout does not change the committed state until its presentation is confirmed.
    await surfaces.place(record(40, false));
    assert.equal(calls.at(-1).request.titlebar, 40);
    assert.equal(chrome.presented().row, 54, "an unpresented preparation replaced the committed chrome");
    await surfaces.place(record(40, true));
    assert.equal(chrome.presented().row, 40);

    // The same request is not sent again. When the state of the window changed without a request (a window that left full screen), the same
    // request is sent after forget.
    calls.length = 0;
    await surfaces.place(record(40, false));
    assert.deepEqual(calls, [], "an unchanged request was sent");
    // The viewport tells the host the size that the layout was made at; a layout at another size that places the same is no change.
    await surfaces.place(record(40, false, { width: 900, height: 600 }));
    assert.deepEqual(calls, [], "a request that changed only its viewport was sent");
    surfaces.forget();
    await surfaces.place(record(40, false));
    await surfaces.place(record(40, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "a forgotten request was not sent again");
    assert.equal(calls[0].request.titlebar, 40);
  } finally {
    dom.window.close();
  }
});

// A declaration in flight is a host call that the host answers in its own step, so a placement waits for that answer and sends
// the view (docs/spec/native-surfaces.md#view-surfaces, placement).
test("native view placement waits for the answer of a composition declaration in flight", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let releaseComposition;
  let declared = false;
  const answered = new Promise((resolve) => { releaseComposition = () => { declared = true; resolve(); }; });
  let waitCount = 0;
  let announceWait;
  const waitStarted = new Promise((resolve) => { announceWait = resolve; });
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: () => ({ surfaceId: "view-ready-barrier" }),
    compositionState: (surfaceId) => {
      assert.equal(surfaceId, "view-ready-barrier");
      if (declared) return { state: "declared" };
      waitCount++;
      announceWait();
      return { state: "declaring", answered };
    },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") return { ticket: 1, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?composition-barrier");
  const record = {
    surfaces: [{ id: "view-ready-barrier", dim: false, visible: true,
      surface: { module: null, pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
      applied: { x: 0, y: 0, w: 3, h: 4 }, start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } }],
    settled: true, drawn: false, titlebar: 40,
  };
  try {
    await surfaces.theme({ scheme: "dark", tokens: {} });
    const placement = surfaces.place(record);
    await waitStarted;
    assert.equal(waitCount, 1, "the declaration in flight was not observed");
    assert.equal(calls.some(({ name }) => name === "syncSurfaces"), false,
      "native view placement began before the host answered the declaration in flight");
    releaseComposition();
    assert.deepEqual(await placement, { placements: [], deferred: [] });
    assert.deepEqual(calls.filter(({ name }) => name === "syncSurfaces").map(({ request }) => request.surfaces.map(({ id }) => id)),
      [["view-ready-barrier"]], "the placement did not send the view after its declaration answered");
  } finally {
    dom.window.close();
  }
});

// A declaration that the host refused, or a surface disposed before it declared, leaves no declaration in the host: the placement
// defers that view and sends the rest of the window (docs/spec/native-surfaces.md#view-surfaces, placement).
test("native view placement defers a view whose declaration was refused when its surface was disposed", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let refused = false;
  let rejectComposition;
  const answered = new Promise((resolve) => { rejectComposition = () => { refused = true; resolve(); }; });
  let announceWait;
  const waitStarted = new Promise((resolve) => { announceWait = resolve; });
  const holds = [];
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: () => ({ surfaceId: "view-disposed" }),
    compositionState: () => {
      if (refused) return { state: "pending" };
      announceWait();
      return { state: "declaring", answered };
    },
    holdCompositionDeclarations: (ids) => { holds.push([...ids]); },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") return { ticket: 1, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?composition-disposed");
  const record = {
    surfaces: [{ id: "view-disposed", dim: false, visible: true,
      surface: { module: null, pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
      applied: { x: 0, y: 0, w: 3, h: 4 }, start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } }],
    settled: true, drawn: true, titlebar: 40,
  };
  try {
    await surfaces.theme({ scheme: "dark", tokens: {} });
    const placement = surfaces.place(record);
    await waitStarted;
    rejectComposition();
    assert.deepEqual(await placement, { placements: [], deferred: ["view-disposed"] },
      "the placement did not defer the view whose declaration was refused");
    assert.deepEqual(calls.filter(({ name }) => name === "syncSurfaces").map(({ request }) => request.surfaces.map(({ id }) => id)),
      [[]], "the placement sent a view that has no declaration");
    assert.deepEqual(holds, [["view-disposed"]]);
    assert.equal(surfaces.waitsForDeclaration("view-disposed"), true);
  } finally {
    dom.window.close();
  }
});

// A preparation defers a view that has no mount yet; the drawn commit follows the plane draw that mounts it, and a declaration
// that is in flight then is answered before the commit sends the view (docs/spec/native-surfaces.md#view-surfaces).
test("an initial placement defers an unmounted view until its drawn commit", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  const order = [];
  let mounted = { surfaceId: "view-mount-order", disposed: true };
  let declared = false;
  let announceWait;
  let releaseRegistration;
  const waitStarted = new Promise((resolve) => { announceWait = resolve; });
  const registrationReady = new Promise((resolve) => { releaseRegistration = resolve; });
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (surfaceId) => surfaceId === "view-mount-order" ? mounted : null,
    compositionState: (surfaceId) => {
      assert.equal(mounted.disposed, false, `the composition of ${surfaceId} was read before its replacement was mounted`);
      if (declared) return { state: "declared" };
      order.push(`composition:${surfaceId}`);
      announceWait();
      return { state: "declaring", answered: registrationReady.then(() => { declared = true; }) };
    },
    holdCompositionDeclarations: (surfaceIds) => { order.push(`hold:${surfaceIds.join(",")}`); },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === "syncSurfaces") {
        order.push("syncSurfaces");
        return {
          ticket: 1,
          placements: request.surfaces.map((surface) => ({
            id: surface.id, visible: true, scale: 2, x: surface.x, y: surface.y, w: surface.w, h: surface.h,
          })),
          chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar },
        };
      }
      if (name === "presentSurfaces") {
        order.push("presentSurfaces");
        return request.placements;
      }
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?initial-view-mount-order");
  const record = (drawn) => {
    return {
      surfaces: [{ id: "view-mount-order", dim: false, visible: true,
        surface: { module: null, pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
        applied: { x: 1, y: 2, w: 30, h: 40 }, start: { origin: { directory: null }, declarations: emptySurfaceDeclarations } }],
      settled: true, drawn, titlebar: 40,
    };
  };
  try {
    await surfaces.theme({ scheme: "dark", tokens: {} });
    const first = await surfaces.place(record(false));
    assert.deepEqual(first, { placements: [], deferred: ["view-mount-order"] },
      "the unmounted view must be explicitly deferred without a fabricated placement");
    assert.deepEqual(calls.find(({ name }) => name === "syncSurfaces").request.surfaces, [],
      "the host declaration fence must not receive an unmounted view");
    assert.equal(order.includes("composition:view-mount-order"), false,
      "pre-draw placement waited for a replacement mount that drawing has not started");

    // The plane draw mounts the view, whose declaration is in flight when the drawn commit starts.
    mounted = { surfaceId: "view-mount-order", disposed: false };
    const secondPending = surfaces.place(record(true));
    await waitStarted;
    assert.equal(calls.filter(({ name }) => name === "syncSurfaces").length, 1,
      "the drawn view was sent while its declaration was in flight");
    releaseRegistration();
    const second = await secondPending;
    assert.deepEqual(second, {
      placements: [{ id: "view-mount-order", visible: true, scale: 2, x: 1, y: 2, w: 30, h: 40 }], deferred: [],
    });
    assert.deepEqual(calls.filter(({ name }) => name === "syncSurfaces").at(-1).request.surfaces.map(({ id }) => [id]),
      [["view-mount-order"]], "the declared view was not sent after mount registration");
    assert.deepEqual(order, ["hold:view-mount-order", "syncSurfaces", "composition:view-mount-order", "syncSurfaces", "presentSurfaces"]);
  } finally {
    dom.window.close();
  }
});

test("a release during an open preparation presents that preparation as settled without a second synchronization", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let ticket = 0;
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: () => null,
    compositionState: () => ({ state: "declared" }),
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "log") return clockAnswer(name, request);
      calls.push({ name, request });
      if (name === "syncSurfaces") return { ticket: ++ticket, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?release");
  const record = (drawn, settled) => ({ surfaces: [], settled, drawn, titlebar: 40 });
  try {
    await surfaces.place(record(false, false));
    await surfaces.place(record(true, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "the settled value alone sent a second synchronization of an open preparation");
    assert.deepEqual([calls[1].request.ticket, calls[1].request.settled], [1, true],
      "the open preparation was not presented as settled");
    await surfaces.place(record(false, false));
    await surfaces.place(record(true, false));
    calls.length = 0;
    await surfaces.place(record(true, true));
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"],
      "a release after the presentation of an equal placement did not end the run");
    assert.equal(calls[1].request.settled, true);
  } finally {
    dom.window.close();
  }
});

test("a cancelled preparation sends its ticket once and the next equal request is sent again", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let ticket = 0;
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: () => null,
    compositionState: () => ({ state: "declared" }),
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "log") return clockAnswer(name, request);
      calls.push({ name, request });
      if (name === "syncSurfaces") return { ticket: ++ticket, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } };
      if (name === "presentSurfaces") return request.placements;
      if (name === "cancelSurfaces") return null;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?cancel");
  const record = (drawn) => ({ surfaces: [], settled: true, drawn, titlebar: 40 });
  try {
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(calls, [], "no preparation is open");
    await surfaces.place(record(false));
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "cancelSurfaces"]);
    assert.deepEqual(calls[1].request, { ticket: 1 });
    await surfaces.cancelPrepared({ handover: false });
    assert.equal(calls.length, 2, "a cancelled preparation is not cancelled again");
    await surfaces.place(record(false));
    await surfaces.place(record(true));
    assert.deepEqual(calls.slice(2).map((c) => c.name), ["syncSurfaces", "presentSurfaces"], "the equal request after a cancellation was not sent");
    await surfaces.cancelPrepared({ handover: false });
    assert.equal(calls.length, 4, "a presented preparation is not cancelled");
  } finally {
    dom.window.close();
  }
});

// A handed-over preparation stays open for the next preparation of the window, which places every surface again and commits
// both with its own presentation (F484). Every exit ends it: a failed next preparation and a cancel without a handover cancel it.
test("a handed-over preparation sends no cancel and only a failed or cancelled next preparation ends it", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let ticket = 0;
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: () => null,
    compositionState: () => ({ state: "declared" }),
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      if (name === "log") return clockAnswer(name, request);
      calls.push({ name, request });
      if (name === "syncSurfaces") {
        if (request.titlebar === 99) throw new Error("preparation refused");
        return { ticket: ++ticket, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar } };
      }
      if (name === "presentSurfaces") return request.placements;
      if (name === "cancelSurfaces") return null;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?handover");
  const record = (drawn, titlebar = 40) => ({ surfaces: [], settled: true, drawn, titlebar });
  const names = () => calls.map((c) => c.name);
  try {
    await surfaces.place(record(false));
    await surfaces.cancelPrepared({ handover: true });
    assert.deepEqual(names(), ["syncSurfaces"], "a handed-over preparation was cancelled and committed");
    await surfaces.place(record(false));
    await surfaces.place(record(true));
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(names(), ["syncSurfaces", "syncSurfaces", "presentSurfaces"],
      "the next preparation did not take over the handed-over preparation");

    calls.length = 0;
    await surfaces.place(record(false, 41));
    await surfaces.cancelPrepared({ handover: true });
    await assert.rejects(surfaces.place(record(false, 99)), /preparation refused/);
    assert.deepEqual(names(), ["syncSurfaces", "syncSurfaces", "cancelSurfaces"], "a failed next preparation left the handed-over one open");
    assert.deepEqual(calls[2].request, { ticket: 3 });
    await surfaces.cancelPrepared({ handover: false });
    assert.equal(calls.length, 3, "the cancel after a failed preparation sent a call or found an open preparation");

    calls.length = 0;
    await surfaces.place(record(false, 42));
    await surfaces.cancelPrepared({ handover: true });
    await surfaces.cancelPrepared({ handover: false });
    assert.deepEqual(names(), ["syncSurfaces", "cancelSurfaces"], "a cancel without a handover left the handed-over preparation open");
    assert.deepEqual(calls[1].request, { ticket: 4 });
  } finally {
    dom.window.close();
  }
});

// A preparation authorizes its surfaces through the prepared listeners only after it completes, and a listener added later receives the
// current preparation. The drawn commit presents each prepared ticket once with the visibility of its preparation. A rejected
// preparation or presentation is the failure of the placing caller, which reports it, and is not reused for the next request at the
// same geometry.
test("a view preparation notifies its prepared listeners, presents each ticket once, and a rejected stage is not reused", async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  const tickets = [];
  let fail = null;
  t.mock.module("../surface-modules.js", { namedExports: {
    mountedSurface: (surfaceId) => ({ surfaceId }),
    compositionState: () => ({ state: "declared" }),
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "log") return clockAnswer(name, request);
      if (name === "setTheme") return null;
      if (name === fail) { fail = null; throw new Error(`injected ${name} failure`); }
      if (name === "syncSurfaces") {
        tickets.push(tickets.length + 1);
        return {
          ticket: tickets.at(-1),
          placements: [
            { id: "shown", x: 1, y: 2, w: 3, h: 4, visible: true },
            { id: "hidden", x: 0, y: 0, w: 1, h: 1, visible: false },
          ],
          chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar },
        };
      }
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { onSurfacePrepared, surfaces } = await import("../host.js?presentation");
  const view = (id, visible) => ({ id, dim: false, visible,
    surface: { module: null, pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
    applied: { x: 0, y: 0, w: 3, h: 4 } });
  const record = { surfaces: [view("shown", true), view("hidden", false)], settled: false, drawn: false, titlebar: 40 };
  const placing = () => calls.filter(({ name }) => name === "syncSurfaces" || name === "presentSurfaces");
  const prepared = [];
  const removePrepared = onSurfacePrepared((placements) => prepared.push(placements.map(({ id }) => id)));
  try {
    await surfaces.theme({ scheme: "dark", tokens: {} });
    const preparation = await surfaces.place(record);
    assert.deepEqual(preparation.placements.map(({ id, visible }) => [id, visible]), [["shown", true], ["hidden", false]],
      "the preparation did not keep the visibility that the host placed");
    assert.deepEqual(placing().map(({ name }) => name), ["syncSurfaces"]);
    assert.deepEqual(prepared, [["shown", "hidden"]], "the prepared listeners were not told after the preparation completed");
    const latePrepared = [];
    const removeLatePrepared = onSurfacePrepared((placements) => latePrepared.push(placements.map(({ id }) => id)));
    assert.deepEqual(latePrepared, [["shown", "hidden"]], "a listener added after the preparation did not receive it");
    removeLatePrepared();
    await surfaces.place({ ...record, drawn: true });
    await surfaces.place({ ...record, drawn: true });
    assert.deepEqual(placing().map(({ name }) => name), ["syncSurfaces", "presentSurfaces"], "a prepared ticket was presented twice");
    const presented = placing()[1].request;
    assert.equal(presented.ticket, tickets[0]);
    assert.deepEqual(presented.placements.map(({ id, visible }) => [id, visible]), [["shown", true], ["hidden", false]],
      "the presentation did not keep the visibility of its preparation");
    for (const stage of ["syncSurfaces", "presentSurfaces"]) {
      calls.length = 0;
      fail = stage;
      const changed = { ...record, settled: stage === "syncSurfaces" };
      if (stage === "syncSurfaces") {
        await assert.rejects(surfaces.place(changed), /injected syncSurfaces failure/);
      } else {
        await surfaces.place(changed);
        await assert.rejects(surfaces.place({ ...changed, drawn: true }), /injected presentSurfaces failure/);
      }
      // The page log that host.js loaded relays the records of the turn; a record of the rejection would be among them.
      await (await import("../page-log.js")).flushEvents();
      assert.deepEqual(calls.flatMap((call) => recordsOf(call.name, call.request)), [],
        `the ${stage} rejection that the placing caller received was written again`);
      calls.length = 0;
      await surfaces.place(changed);
      await surfaces.place({ ...changed, drawn: true });
      assert.deepEqual(placing().map(({ name }) => name), ["syncSurfaces", "presentSurfaces"],
        `the ${stage} rejection was reused for the next request at the same geometry`);
    }
  } finally {
    removePrepared();
    dom.window.close();
  }
});
