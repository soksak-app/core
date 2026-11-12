import assert from "node:assert/strict";
import test from "node:test";
import {
  checkViewDisplay as acceptViewDisplay, expectedPresentations, observeViewDisplay as checkViewDisplay, rasterIdentity,
  appDomWebviews, viewPresentationJoins, viewWebviews,
} from "../view-display.mjs";
/** The stop reply of a recording of `count` written stills. */
const stopReply = (count) => ({ frames: "fixture-recording", stills: "fixture-recording/stills.jsonl", count, missed: 0, late: 0,
  longestGap: 16 });

/** A window with two installed views but only one open card. */
function fixture({ openedOnly = false } = {}) {
  const applied = { x: 20, y: 40, w: 120, h: 80 };
  const card = { id: "probe-card", x: 0, y: 0, w: 160, h: 140, focused: true, tabs: [{ id: "probe-original", plugin: "layoutprobe" }] };
  const surface = (id, plugin) => ({ surface: id, plugin, visible: true, composition: "view", applied, declared: applied,
    status: { phase: "ready", error: null }, exposes: ["status core.surface.document"] });
  const original = surface("probe-original", "layoutprobe");
  let current = null;
  const opened = [];
  const plugins = (openedOnly ? ["layoutprobe"] : ["layoutprobe", "probe-unopened"]).map((id) => ({ id, composition: "view", state: "loaded",
    installed: { enabled: true, version: "0.0.1" } }));
  const s = {
    async get(name, tab) {
      if (name === "core.grid") return { plane: { x: 0, y: 0 }, cards: [card] };
      if (name === "core.plugins") return { error: null, reload: false, plugins };
      if (name === "core.surfaces") return current ? [{ ...original, visible: false }, current] : [original];
      if (name === "core.surface.document") {
        assert.equal(tab, current?.surface, "the checker read another tab's document");
        return { readyState: "complete", themed: true, unbound: [], timeOrigin: 100 };
      }
      if (name === "core.workbench.audit") return { unbound: [] };
      if (name === "host.window") return { surfaces: current ? [{ id: current.surface,
        frame: { x: applied.x, y: applied.y, width: applied.w, height: applied.h } }] : [] };
      throw new Error(`unexpected status ${name}`);
    },
    async run(name, params) {
      if (name === "core.card.add-tab") {
        opened.push(params.plugin);
        current = surface(`probe-tab-${opened.length}`, params.plugin);
        return { tab: current.surface };
      }
      if (name === "core.tab.close") {
        assert.equal(params.tab, current.surface);
        current = null;
        return null;
      }
      throw new Error(`unexpected command ${name}`);
    },
    async until(name, predicate, message, options = {}) {
      const value = await s.get(name, options.surface);
      assert.ok(predicate(value), message);
      return value;
    },
    async presented() { return { displayed: 150 }; },
    async record() { return { frames: "fixture-recording", stop: async () => stopReply(2) }; },
  };
  return { s, opened };
}

test("the view display checker covers an installed view that has no open card", { timeout: 5000 }, async (t) => {
  const f = fixture();
  await checkViewDisplay(f.s, t);
  assert.deepEqual(f.opened, ["layoutprobe", "probe-unopened"], "an installed view without a card was omitted");
});

test("the view display checker rejects a missing plugin content case with its opened tab", { timeout: 5000 }, async (t) => {
  const f = fixture();
  await assert.rejects(acceptViewDisplay(f.s, t, new Map(), ["layoutprobe"]), /layoutprobe.*probe-tab-1.*content case/);
});

test("the view display check opens only the view plugins of its content cases", { timeout: 5000 }, async (t) => {
  const f = fixture();
  await acceptViewDisplay(f.s, t, new Map([["layoutprobe", { ready: async () => async () => {} }]]));
  assert.deepEqual(f.opened, ["layoutprobe"], "the check opened an installed view that has no content case");
});

test("the view display check refuses a vehicle that is not an installed enabled view and a check without a vehicle", { timeout: 5000 }, async (t) => {
  const f = fixture();
  await assert.rejects(acceptViewDisplay(f.s, t, new Map([["probe-missing", { ready: async () => async () => {} }]])),
    /probe-missing is not an installed enabled view plugin/);
  await assert.rejects(acceptViewDisplay(f.s, t, new Map()), /names no view plugin to open/);
  assert.deepEqual(f.opened, [], "a refused check opened a view");
});

test("view content readiness is verified before the recording stops", { timeout: 5000 }, async (t) => {
  const f = fixture({ openedOnly: true });
  let stopped = false;
  f.s.record = async () => ({ frames: "fixture-recording", stop: async () => {
    stopped = true;
    return stopReply(2);
  } });
  await acceptViewDisplay(f.s, t, new Map([["layoutprobe", { ready: async () => {
    assert.equal(stopped, false, "recording ended before content readiness");
    return async () => {};
  } }]]));
  assert.equal(stopped, true);
});

test("a failed view readiness check closes the opened tab", { timeout: 5000 }, async (t) => {
  const f = fixture({ openedOnly: true });
  const until = f.s.until;
  let refused = false;
  f.s.until = async (...args) => {
    if (args[0] === "core.surfaces" && !refused) {
      refused = true;
      throw new Error("forced surface readiness failure");
    }
    return until(...args);
  };
  await assert.rejects(acceptViewDisplay(f.s, t, new Map(), ["layoutprobe"]), /forced surface readiness failure/);
  assert.deepEqual((await f.s.get("core.surfaces")).map(item => item.surface), ["probe-original"],
    "failed view preparation left its opened tab in the next check");
});

test("view display rejects a readiness-only case without a content verifier", { timeout: 5000 }, async (t) => {
  const f = fixture({ openedOnly: true });
  await assert.rejects(acceptViewDisplay(f.s, t,
    new Map([["layoutprobe", { ready: async () => undefined }]])), /content verifier/);
});

test("view display runs the content verifier of the case after the recording stops", { timeout: 5000 }, async (t) => {
  const f = fixture({ openedOnly: true });
  let stopped = false;
  f.s.record = async () => ({ frames: "fixture-recording", stop: async () => {
    stopped = true;
    return stopReply(2);
  } });
  let verified = false;
  await acceptViewDisplay(f.s, t, new Map([["layoutprobe", { ready: async () => async (...args) => {
    assert.deepEqual(args, [], "the content verifier received recorded pixels");
    assert.equal(stopped, true, "the content verifier ran before the recording stopped");
    verified = true;
  } }]]));
  assert.equal(verified, true, "the content verifier was never executed");
});

test("view display audits controls after its declared content readiness", { timeout: 5000 }, async (t) => {
  const f = fixture({ openedOnly: true });
  const get = f.s.get;
  let ready = false;
  f.s.get = async (...args) => {
    const value = await get(...args);
    if (args[0] === "core.surface.document" && !ready) return { ...value, unbound: [{ role: "button" }] };
    return value;
  };
  await acceptViewDisplay(f.s, t, new Map([["layoutprobe", { ready: async () => {
    ready = true;
    return async () => {};
  } }]]));
});

test("a content verifier decides the content of a view", { timeout: 5000 }, async (t) => {
  const f = fixture({ openedOnly: true });
  await assert.rejects(acceptViewDisplay(f.s, t, new Map([["layoutprobe", { ready: async () => async () => {
    throw new Error("layoutprobe probe-tab-1 does not show the expected text");
  } }]])), /does not show the expected text/);
  await acceptViewDisplay(f.s, t, new Map([["layoutprobe", { ready: async () => async () => {} }]]));
});

const traceRow = (event, fields) => ({ layer: "host", event, ts: "2026-10-29T00:00:00.000Z", ...fields });

test("view presentation joins name the phases and abandonments of one surface in row order", { timeout: 5000 }, () => {
  const rows = [
    traceRow("view.presentation-join", { surface: "view-a", generation: 1, ticket: 4, phase: "requested" }),
    traceRow("view.presentation-join", { surface: "view-a", generation: 1, ticket: 4, phase: "result", joined: true }),
    traceRow("view.presentation-join", { surface: "view-b", generation: 1, ticket: 4, phase: "requested" }),
    traceRow("view.presentation-join", { surface: "view-a", generation: 1, ticket: 4, phase: "presented" }),
    { layer: "workbench", event: "view.presentation-join", surface: "view-a", phase: "presented" },
  ];
  assert.deepEqual(viewPresentationJoins(rows, "view-a"), {
    phases: ["requested", "result", "presented"], abandoned: [],
  });
  assert.deepEqual(viewPresentationJoins(rows, "view-b"), { phases: ["requested"], abandoned: [] });
  assert.deepEqual(viewPresentationJoins(rows, "view-c"), { phases: [], abandoned: [] });
});

test("view presentation joins report presentation-abandoned rows and reject unknown phases", { timeout: 5000 }, () => {
  const rows = [
    traceRow("view.presentation-join", { surface: "view-a", generation: 1, ticket: 5, phase: "abandoned", reason: "hidden" }),
    traceRow("view.presentation-abandoned", { surface: "view-a", reason: "hidden" }),
  ];
  assert.deepEqual(viewPresentationJoins(rows, "view-a"), { phases: ["abandoned"], abandoned: ["hidden"] });
  assert.throws(() => viewPresentationJoins([
    traceRow("view.presentation-join", { surface: "view-a", generation: 1, ticket: 6, phase: "pending" }),
  ], "view-a"), /unknown phase/);
  assert.throws(() => viewPresentationJoins(rows, ""), /surface must be nonempty/);
  assert.throws(() => viewPresentationJoins({}, "view-a"), /must be an array/);
});

test("a hidden region keeps its raster identity when a later frame of the same raster is presented", { timeout: 5000 }, () => {
  // The values that a hiding check recorded for one image region: the same generation and raster, with a later sequence.
  const shown = { generation: 311, height: 286, raster: 1, scale: 1, sequence: 2, width: 180 };
  const hidden = { ...shown, sequence: 4 };
  assert.deepEqual(rasterIdentity(hidden), rasterIdentity(shown), "hiding changed its raster");
  assert.notEqual(hidden.sequence, shown.sequence, "the fixture must hold a later sequence");
});

test("the raster identity changes when the generation, raster or size of the raster changes", { timeout: 5000 }, () => {
  const shown = { generation: 311, height: 286, raster: 1, scale: 1, sequence: 2, width: 180 };
  for (const change of [{ generation: 312 }, { raster: 2 }, { width: 181 }, { height: 287 }, { scale: 2 }]) {
    assert.notDeepEqual(rasterIdentity({ ...shown, ...change }), rasterIdentity(shown), JSON.stringify(change));
  }
  assert.throws(() => rasterIdentity({ generation: 311 }), /has no raster/);
});

const placedAt = (surface, x) => traceRow("surface", { phase: "placed", surface, x, y: 0, w: 200, h: 300, visible: true });

test("a view whose placement does not change in a divider drag is not awaited", { timeout: 5000 }, () => {
  const baseline = [placedAt("view-a", 0), placedAt("view-b", 200)];
  const window = [
    placedAt("view-a", 0), placedAt("view-b", 260),
    placedAt("view-a", 0), placedAt("view-b", 320),
  ];
  assert.deepEqual(expectedPresentations(baseline, window, ["view-a", "view-b"]), ["view-b"]);
});

test("a view that moves once from its placement before the drag is awaited", { timeout: 5000 }, () => {
  const baseline = [placedAt("view-a", 0), placedAt("view-b", 200)];
  const window = [placedAt("view-a", 0), placedAt("view-b", 260)];
  assert.deepEqual(expectedPresentations(baseline, window, ["view-a", "view-b"]), ["view-b"]);
});

test("a view created before the drag without a placed row is awaited", { timeout: 5000 }, () => {
  const baseline = [placedAt("view-a", 0), traceRow("surface", { phase: "created", surface: "view-b" })];
  const window = [placedAt("view-a", 0), placedAt("view-b", 200)];
  assert.deepEqual(expectedPresentations(baseline, window, ["view-a", "view-b"]), ["view-b"]);
});

test("a view that the baseline rows do not cover is rejected instead of awaited", { timeout: 5000 }, () => {
  // The rows of set 0 of a Wails run: the baseline started after the last placement before the drag, and tab-pmhp35 kept its
  // placement while the two other views moved.
  const placed = (surface, x, w) => traceRow("surface", { phase: "placed", surface, x, y: 116, w, h: 286, visible: true });
  const window = [placed("tab-l3zyob", 210, 263), placed("tab-pmhp35", 597, 373), placed("tab-pre4dr", 487, 96)];
  assert.throws(() => expectedPresentations([], window, ["tab-l3zyob", "tab-pmhp35", "tab-pre4dr"]),
    /baseline rows hold no created or placed row of tab-l3zyob/);
  const baseline = [traceRow("surface", { phase: "created", surface: "tab-l3zyob" }), placed("tab-l3zyob", 210, 179),
    traceRow("surface", { phase: "created", surface: "tab-pmhp35" }), placed("tab-pmhp35", 597, 373),
    traceRow("surface", { phase: "created", surface: "tab-pre4dr" }), placed("tab-pre4dr", 403, 180)];
  assert.deepEqual(expectedPresentations(baseline, window, ["tab-l3zyob", "tab-pmhp35", "tab-pre4dr"]),
    ["tab-l3zyob", "tab-pre4dr"]);
});

test("each loaded view surface of core.surfaces counts one view web view, shown or retained", () => {
  // The window of the view-surfaces check: a raster probe tab was added to the card of a layout probe tab, which keeps its view
  // retained behind it; two more raster probe cards and a second layout probe card are shown, and a sidebar holds one section.
  const entry = (surface, plugin, fields = {}) => ({ surface, plugin, kind: "tab", sidebar: null, visible: true, composition: "view",
    placeholder: null, state: "loaded", ...fields });
  const surfaces = [
    entry("tab-top", "layoutprobe"),
    entry("tab-r1", "rasterprobe"), entry("tab-r2", "rasterprobe"), entry("tab-r3", "rasterprobe"),
    entry("tab-split", "layoutprobe"),
    entry("tab-behind", "layoutprobe", { visible: false }),
    entry("spc-1/left/layoutprobe.list", "layoutprobe", { kind: "section", sidebar: "left", visible: false }),
    // Neither an unloaded tab nor a placeholder has a view web view.
    entry("tab-unloaded", "layoutprobe", { visible: false, state: "unloaded" }),
    { surface: "tab-missing", plugin: "gone", visible: true, placeholder: "missing", composition: null, kind: "tab", sidebar: null },
  ];
  const views = viewWebviews(surfaces);
  assert.deepEqual(views.tabs.map((item) => item.surface),
    ["tab-top", "tab-r1", "tab-r2", "tab-r3", "tab-split", "tab-behind"]);
  assert.deepEqual(views.sections.map((item) => item.surface), ["spc-1/left/layoutprobe.list"]);
  assert.throws(() => viewWebviews([entry("tab-x", "layoutprobe", { state: "restoring" })]), /tab-x/,
    "a view whose web view is being restored has no count yet");
});

test("the app DOM web views of a window are its main page, when it has one, and one view web view for each loaded view", () => {
  // A window of the Wails and Tauri hosts has one app DOM web view, its main page; a window of the mygo host draws the workbench in
  // native UI and has none (docs/spec/plugins.md#surface-ownership). Each loaded view holds its own web view on every host.
  const entry = (surface, plugin, fields = {}) => ({ surface, plugin, kind: "tab", sidebar: null, visible: true, composition: "view",
    placeholder: null, state: "loaded", ...fields });
  const surfaces = [entry("tab-a", "layoutprobe"), entry("tab-b", "rasterprobe"),
    entry("spc-1/left/layoutprobe.list", "layoutprobe", { kind: "section", sidebar: "left" })];
  const paged = appDomWebviews(surfaces, { mainPage: true });
  assert.equal(paged.mainPages, 1);
  assert.equal(paged.count, 4);
  const native = appDomWebviews(surfaces, { mainPage: false });
  assert.equal(native.mainPages, 0);
  assert.equal(native.count, 3);
  assert.deepEqual(native.tabs.map((item) => item.surface), ["tab-a", "tab-b"]);
  assert.deepEqual(native.sections.map((item) => item.surface), ["spc-1/left/layoutprobe.list"]);
  assert.throws(() => appDomWebviews(surfaces, {}), /mainPage/, "a window names whether it has a main page");
});
