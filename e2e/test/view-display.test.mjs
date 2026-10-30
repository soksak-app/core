import assert from "node:assert/strict";
import test from "node:test";
import {
  checkViewDisplay as acceptViewDisplay, expectedPresentations, observeViewDisplay as checkViewDisplay, rasterIdentity,
  viewPresentationJoins,
} from "../view-display.mjs";

/** A window with two installed views but only one open card, and decoded frames of that card. */
function fixture({ blank = false, offset = 0, terminalOnly = false } = {}) {
  const applied = { x: 20, y: 40, w: 120, h: 80 };
  const card = { id: "probe-card", x: 0, y: 0, w: 160, h: 140, tabs: [{ id: "probe-original", plugin: "terminal" }] };
  const surface = (id, plugin) => ({ surface: id, plugin, visible: true, composition: "view", applied, declared: applied,
    status: { phase: "ready", error: null }, exposes: ["status core.surface.document"] });
  const original = surface("probe-original", "terminal");
  let current = null;
  const opened = [];
  const frame = { width: 400, height: 400, stride: 1600, scale: 1, contentScale: 1,
    content: { x: offset, y: offset, width: 160, height: 140 }, time: 200, data: Buffer.alloc(640000, 255) };
  const paint = (x, y, value) => {
    const at = (y + offset) * frame.stride + (x + offset) * 4;
    frame.data[at] = value; frame.data[at + 1] = value; frame.data[at + 2] = value;
  };
  if (blank) for (let y = 0; y < 30; y++) for (let x = 0; x < 160; x++) paint(x, y, x < 80 ? 0 : 160);
  else for (let y = 40; y < 120; y++) for (let x = 20; x < 80; x++) paint(x, y, 0);
  const plugins = (terminalOnly ? ["terminal"] : ["terminal", "probe-unopened"]).map((id) => ({ id, composition: "view", state: "loaded",
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
      if (name === "core.page.audit") return { unbound: [] };
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
    async record() { return { frames: "fixture-recording", stop: async () => ({ count: 2, limited: false, longestGap: 16 }) }; },
  };
  return { s, opened, readRecording: () => [frame, { ...frame, time: 216 }] };
}

test("the view display checker covers an installed view that has no open card", { timeout: 5000 }, async (t) => {
  const f = fixture();
  await checkViewDisplay(f.s, t, f.readRecording);
  assert.deepEqual(f.opened, ["terminal", "probe-unopened"], "an installed view without a card was omitted");
});

test("the view display checker rejects a blank view surrounded by coloured card chrome", { timeout: 5000 }, async (t) => {
  const f = fixture({ blank: true });
  await assert.rejects(checkViewDisplay(f.s, t, f.readRecording), /blank|no recorded frame.*content/);
});

test("the view display checker measures content at a nonzero capture offset", { timeout: 5000 }, async (t) => {
  const f = fixture({ offset: 200 });
  await checkViewDisplay(f.s, t, f.readRecording);
});

test("the view display checker rejects a missing plugin content case with its opened tab", { timeout: 5000 }, async (t) => {
  const f = fixture();
  await assert.rejects(acceptViewDisplay(f.s, t, f.readRecording, new Map()), /terminal.*probe-tab-1.*content case/);
});

test("view content readiness is verified before the recording stops", { timeout: 5000 }, async (t) => {
  const f = fixture({ terminalOnly: true });
  let stopped = false;
  f.s.record = async () => ({ frames: "fixture-recording", stop: async () => {
    stopped = true;
    return { count: 2, limited: false, longestGap: 16 };
  } });
  await acceptViewDisplay(f.s, t, f.readRecording, new Map([["terminal", { ready: async () => {
    assert.equal(stopped, false, "recording ended before content readiness");
    return async () => {};
  } }]]));
  assert.equal(stopped, true);
});

test("a failed view readiness check closes the opened tab", { timeout: 5000 }, async (t) => {
  const f = fixture({ terminalOnly: true });
  const until = f.s.until;
  let refused = false;
  f.s.until = async (...args) => {
    if (args[0] === "core.surfaces" && !refused) {
      refused = true;
      throw new Error("forced surface readiness failure");
    }
    return until(...args);
  };
  await assert.rejects(acceptViewDisplay(f.s, t, f.readRecording, new Map()), /forced surface readiness failure/);
  assert.deepEqual((await f.s.get("core.surfaces")).map(item => item.surface), ["probe-original"],
    "failed view preparation left its opened tab in the next check");
});

test("view display rejects a readiness-only case without captured-pixel verification", { timeout: 5000 }, async (t) => {
  const f = fixture({ terminalOnly: true });
  await assert.rejects(acceptViewDisplay(f.s, t, f.readRecording,
    new Map([["terminal", { ready: async () => undefined }]])), /captured.pixel/);
});

test("view display executes the case against its decoded capture", { timeout: 5000 }, async (t) => {
  const f = fixture({ terminalOnly: true });
  let measured = false;
  await acceptViewDisplay(f.s, t, f.readRecording, new Map([["terminal", { ready: async () => async ({ captured }) => {
    assert.equal(captured.length, 2);
    measured = true;
  } }]]));
  assert.equal(measured, true, "the expected-pixel case was never executed");
});

test("view display rejects missing finalized frame files", { timeout: 5000 }, async (t) => {
  const f = fixture({ terminalOnly: true });
  f.s.record = async () => ({ frames: "fixture-recording", stop: async () => ({ count: 3, limited: false, longestGap: 16 }) });
  await assert.rejects(checkViewDisplay(f.s, t, f.readRecording), /frame.*count|missing.*frame/);
});

test("view display audits controls after its declared content readiness", { timeout: 5000 }, async (t) => {
  const f = fixture({ terminalOnly: true });
  const get = f.s.get;
  let ready = false;
  f.s.get = async (...args) => {
    const value = await get(...args);
    if (args[0] === "core.surface.document" && !ready) return { ...value, unbound: [{ tag: "button" }] };
    return value;
  };
  await acceptViewDisplay(f.s, t, f.readRecording, new Map([["terminal", { ready: async () => {
    ready = true;
    return async () => {};
  } }]]));
});

test("an explicit pixel verifier covers content between sparse colour samples", { timeout: 5000 }, async (t) => {
  const f = fixture({ terminalOnly: true, blank: true });
  const captured = f.readRecording();
  const at = (41 * captured[0].stride + 21 * 4);
  captured[0].data.fill(0, at, at + 3);
  await acceptViewDisplay(f.s, t, () => captured, new Map([["terminal", { ready: async () => async ({ captured: frames }) => {
    assert.deepEqual([...frames.at(-1).data.subarray(at, at + 3)], [0, 0, 0]);
  } }]]));
});

const traceRow = (event, fields) => ({ layer: "host", event, ts: "2026-10-29T00:00:00.000Z", ...fields });

test("view presentation joins name the phases and abandonments of one surface in row order", { timeout: 5000 }, () => {
  const rows = [
    traceRow("view.presentation-join", { surface: "terminal-a", generation: 1, ticket: 4, phase: "requested" }),
    traceRow("view.presentation-join", { surface: "terminal-a", generation: 1, ticket: 4, phase: "result", joined: true }),
    traceRow("view.presentation-join", { surface: "terminal-b", generation: 1, ticket: 4, phase: "requested" }),
    traceRow("view.presentation-join", { surface: "terminal-a", generation: 1, ticket: 4, phase: "presented" }),
    { layer: "page", event: "view.presentation-join", surface: "terminal-a", phase: "presented" },
  ];
  assert.deepEqual(viewPresentationJoins(rows, "terminal-a"), {
    phases: ["requested", "result", "presented"], abandoned: [],
  });
  assert.deepEqual(viewPresentationJoins(rows, "terminal-b"), { phases: ["requested"], abandoned: [] });
  assert.deepEqual(viewPresentationJoins(rows, "terminal-c"), { phases: [], abandoned: [] });
});

test("view presentation joins report presentation-abandoned rows and reject unknown phases", { timeout: 5000 }, () => {
  const rows = [
    traceRow("view.presentation-join", { surface: "terminal-a", generation: 1, ticket: 5, phase: "abandoned", reason: "hidden" }),
    traceRow("view.presentation-abandoned", { surface: "terminal-a", reason: "hidden" }),
  ];
  assert.deepEqual(viewPresentationJoins(rows, "terminal-a"), { phases: ["abandoned"], abandoned: ["hidden"] });
  assert.throws(() => viewPresentationJoins([
    traceRow("view.presentation-join", { surface: "terminal-a", generation: 1, ticket: 6, phase: "pending" }),
  ], "terminal-a"), /unknown phase/);
  assert.throws(() => viewPresentationJoins(rows, ""), /surface must be nonempty/);
  assert.throws(() => viewPresentationJoins({}, "terminal-a"), /must be an array/);
});

test("a hidden region keeps its raster identity when a later frame of the same raster is presented", { timeout: 5000 }, () => {
  // The values that the hiding check of terminal.test.mjs recorded for one terminal: the same generation and raster, with a later sequence.
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

test("a terminal whose placement does not change in a divider drag is not awaited", { timeout: 5000 }, () => {
  const baseline = [placedAt("terminal-a", 0), placedAt("terminal-b", 200)];
  const window = [
    placedAt("terminal-a", 0), placedAt("terminal-b", 260),
    placedAt("terminal-a", 0), placedAt("terminal-b", 320),
  ];
  assert.deepEqual(expectedPresentations(baseline, window, ["terminal-a", "terminal-b"]), ["terminal-b"]);
});

test("a terminal that moves once from its placement before the drag is awaited", { timeout: 5000 }, () => {
  const baseline = [placedAt("terminal-a", 0), placedAt("terminal-b", 200)];
  const window = [placedAt("terminal-a", 0), placedAt("terminal-b", 260)];
  assert.deepEqual(expectedPresentations(baseline, window, ["terminal-a", "terminal-b"]), ["terminal-b"]);
});

test("a terminal without a placed row before the drag is awaited", { timeout: 5000 }, () => {
  const baseline = [placedAt("terminal-a", 0)];
  const window = [placedAt("terminal-a", 0), placedAt("terminal-b", 200)];
  assert.deepEqual(expectedPresentations(baseline, window, ["terminal-a", "terminal-b"]), ["terminal-b"]);
});
