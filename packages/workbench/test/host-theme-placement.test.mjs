import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

const viewRecord = () => ({
  surfaces: [{ id: "view", plugin: "probe", dim: false, visible: true,
    surface: { pluginId: "probe", composition: { kind: "view", page: "ui/page.html" } },
    applied: { x: 0, y: 0, w: 3, h: 4 } }],
  settled: true, drawn: false, titlebar: 40,
});

const frame = (request) => ({
  ticket: 1, placements: [], chrome: { controls: { x: 13, y: 13, w: 54, h: 14 }, row: request.titlebar },
});

test("view placement waits for the latest host theme reply", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  const themeReplies = [];
  let secondThemeSent;
  const secondThemeStarted = new Promise((resolve) => { secondThemeSent = resolve; });
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} }, emitEvent: () => {}, reportRecord: async () => {},
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: (name, request) => {
      calls.push({ name, request });
      if (name === "setTheme") return new Promise((resolve) => {
        themeReplies.push({ scheme: request.scheme, resolve });
        if (request.scheme === "second") secondThemeSent();
      });
      if (name === "syncSurfaces") return Promise.resolve(frame(request));
      if (name === "presentSurfaces") return Promise.resolve(request.placements);
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?theme-placement-order");
  try {
    const first = surfaces.theme({ scheme: "first", tokens: { "--bg": "#111" } });
    const placing = surfaces.place(viewRecord());
    await Promise.resolve();
    assert.deepEqual(calls.map(({ name }) => name), ["setTheme"], "the view placement started before the first theme reply");

    const second = surfaces.theme({ scheme: "second", tokens: { "--bg": "#222" } });
    themeReplies[0].resolve(null);
    await secondThemeStarted;
    assert.deepEqual(calls.map(({ name }) => name), ["setTheme", "setTheme"], "placement did not wait for the latest theme reply");

    themeReplies[1].resolve(null);
    await Promise.all([first, second, placing]);
    assert.deepEqual(calls.map(({ name }) => name), ["setTheme", "setTheme", "syncSurfaces"]);
  } finally {
    dom.window.close();
  }
});

test("view placement rechecks the theme after its reply continuation", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  const order = [];
  const themeReplies = [];
  let secondThemeSent;
  const secondThemeStarted = new Promise((resolve) => { secondThemeSent = resolve; });
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} }, emitEvent: () => {}, reportRecord: async () => {},
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: (name, request) => {
      calls.push({ name, request });
      order.push(name);
      if (name === "setTheme") return new Promise((resolve) => {
        themeReplies.push({ scheme: request.scheme, resolve });
        if (request.scheme === "second") secondThemeSent();
      });
      if (name === "syncSurfaces") return Promise.resolve(frame(request));
      if (name === "presentSurfaces") return Promise.resolve(request.placements);
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?theme-placement-microtask");
  try {
    const first = surfaces.theme({ scheme: "first", tokens: {} });
    const placing = surfaces.place(viewRecord());
    await Promise.resolve();
    assert.deepEqual(calls.map(({ name }) => name), ["setTheme"]);

    const second = first.then(() => {
      order.push("second theme requested");
      return surfaces.theme({ scheme: "second", tokens: {} });
    });
    themeReplies[0].resolve(null);
    await secondThemeStarted;
    const placementIndex = order.indexOf("syncSurfaces");
    const secondRequestIndex = order.indexOf("second theme requested");
    const secondReplyIndex = order.lastIndexOf("setTheme");
    assert.ok(placementIndex >= 0 && secondRequestIndex >= 0 && secondReplyIndex >= 0);
    if (secondRequestIndex < placementIndex) {
      assert.ok(secondReplyIndex < placementIndex,
        "view placement was sent before the theme request that was queued after the prior reply");
    } else {
      assert.ok(placementIndex < secondReplyIndex,
        "the theme reply was sent before the later theme request");
    }

    themeReplies[1].resolve(null);
    await Promise.all([first, second, placing]);
    assert.equal(calls.filter(({ name }) => name === "syncSurfaces").length, 1);
  } finally {
    dom.window.close();
  }
});

test("a failed theme reply refuses view placement and reports the host error", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  const reports = [];
  let notified;
  const reported = new Promise((resolve) => { notified = resolve; });
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} },
    emitEvent: () => {},
    reportRecord: async (level, line) => { reports.push({ level, line }); notified(); },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: (name, request) => {
      calls.push({ name, request });
      if (name === "setTheme") return Promise.reject(new Error("theme setter refused"));
      if (name === "syncSurfaces") throw new Error("view placement ran after theme failure");
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?theme-placement-failure");
  try {
    const theme = surfaces.theme({ scheme: "broken", tokens: { "--bg": "#333" } });
    const placing = surfaces.place(viewRecord());
    const [themeResult, placeResult] = await Promise.allSettled([theme, placing]);
    await reported;
    assert.equal(themeResult.status, "rejected");
    assert.equal(placeResult.status, "rejected");
    assert.equal(placeResult.reason.message, "theme setter refused");
    assert.equal(calls.filter(({ name }) => name === "syncSurfaces").length, 0, "a view was attached after theme setup failed");
    assert.deepEqual(reports, [{ level: "error", line: "host setTheme failed: Error: theme setter refused" }]);
  } finally {
    dom.window.close();
  }
});

test("a failed theme reply with no view still uses the host error path", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  const reports = [];
  let notified;
  const reported = new Promise((resolve) => { notified = resolve; });
  t.mock.module("../page-log.js", { namedExports: {
    rawConsole: { error: () => {}, info: () => {} },
    emitEvent: () => {},
    reportRecord: async (level, line) => { reports.push({ level, line }); notified(); },
  } });
  t.mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: (name, request) => {
      calls.push({ name, request });
      if (name === "setTheme") return Promise.reject(new Error("theme setter refused"));
      if (name === "syncSurfaces") return Promise.resolve(frame(request));
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { surfaces } = await import("../host.js?theme-error-without-view");
  try {
    await assert.rejects(surfaces.theme({ scheme: "broken", tokens: {} }), /theme setter refused/);
    await reported;
    await surfaces.place({ surfaces: [], settled: true, drawn: false, titlebar: 40 });
    assert.deepEqual(reports, [{ level: "error", line: "host setTheme failed: Error: theme setter refused" }]);
    assert.equal(calls.filter(({ name }) => name === "syncSurfaces").length, 1,
      "a failed theme without a view prevented the ordinary surface layout");
  } finally {
    dom.window.close();
  }
});
