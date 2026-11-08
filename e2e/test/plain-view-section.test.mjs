// The section view of the plain view probe (e2e/fixtures/plain-view/probe): its declarations meet the section-view contract of the view
// benchmark, and its diagnostic module serves that contract on a fake view.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateManifest } from "@soksak/plugin-api";
import { requireSectionDeclarations } from "../benchmark/cases/section-view.mjs";
import { attach, declaredText, markerColorOf } from "../fixtures/plain-view/probe/ui/section-diagnostics.js";

const FOLDER = new URL("../fixtures/plain-view/probe/", import.meta.url);
const read = (name) => readFileSync(new URL(name, FOLDER), "utf8");
const manifest = JSON.parse(read("plugin.json"));
const diagnostics = JSON.parse(read("diagnostics.json"));
const STATUS = "probeplain.section.view.ready";

test("the plain view probe declares one section whose diagnostic declaration meets the section-view contract", () => {
  validateManifest(manifest);
  assert.deepEqual(manifest.sections.map((section) => [section.id, section.composition.page]), [["probeplain.section", "ui/section.html"]]);
  const view = { plugin: "probeplain", section: "probeplain.section", page: "ui/section.html", manifest, diagnostics };
  assert.equal(requireSectionDeclarations(view).content, "Plain section");
  assert.match(read("ui/section.html"), /<p id="content">Plain section<\/p>/);
  assert.ok(JSON.parse(read("package.json")).files.includes("diagnostics.json"), "the package omits diagnostics.json");
});

/** A fake view window whose root has the theme tokens `theme` and whose document is width by height. */
function fakeView(theme = {}) {
  const tokens = { "--card": "#1e1e1e", "--bg": "#141414", "--edge": "#2a2a2a", "--rule": "#333333", "--focus": "#4c8dff", ...theme };
  const observers = [];
  const frames = [];
  const view = {
    document: { documentElement: { getBoundingClientRect: () => ({ width: 240, height: 400 }) }, adoptedStyleSheets: [] },
    getComputedStyle: () => ({ getPropertyValue: (token) => tokens[token] ?? "" }),
    CSSStyleSheet: class { replaceSync(text) { this.text = text; } },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.observed = []; this.disconnected = false; observers.push(this); }
      observe(target) { this.observed.push(target); }
      disconnect() { this.disconnected = true; }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame: () => {},
    performance: { timeOrigin: 1000, now: () => 5 },
    history: { length: 1 },
    observers,
    frames,
  };
  return view;
}

/** Attaches the diagnostic module to `view` and returns its registered commands, its ready read and its trace records. */
async function attached(view, content = { isConnected: true, hidden: false, textContent: "Plain section" }) {
  const commands = new Map();
  const traces = [];
  let readReady = null;
  await attach({
    declaration: diagnostics,
    status: STATUS,
    registerStatus: async (read) => { readReady = read; },
    commands: { register: async (name, handler) => { commands.set(name, handler); } },
    view,
    content,
    log: { trace: (event, fields) => traces.push([event, fields]) },
  });
  return { commands, ready: readReady, traces };
}

test("the section view is ready while it shows the declared text and answers the length of its session history", async () => {
  const content = { isConnected: true, hidden: false, textContent: "Plain section" };
  const { commands, ready } = await attached(fakeView(), content);
  assert.deepEqual([...commands.keys()], ["probeplain.view.frames", "probeplain.view.history"]);
  assert.deepEqual(ready(), { ready: true, content: "Plain section" });
  content.hidden = true;
  assert.deepEqual(ready(), { ready: false, content: "Plain section" });
  assert.deepEqual(await commands.get("probeplain.view.history")(), { length: 1 });
  assert.throws(() => declaredText({ exposes: { status: [] } }, STATUS, "content"), /gives probeplain.section.view.ready no content enum of one string/);
});

test("the frames start paints the root with a marker color apart from the theme, records content frames, and the stop restores the root", async () => {
  const view = fakeView();
  const { commands, traces } = await attached(view);
  const frames = commands.get("probeplain.view.frames");
  const started = await frames({ action: "start" });
  assert.deepEqual(started, { enabled: true, sourceClock: { documentTimeOriginMs: 1000, sourceNowMs: 5, sourceResolutionMs: 1 }, markerColor: [255, 0, 255] });
  assert.deepEqual(view.document.adoptedStyleSheets.map((sheet) => sheet.text), [":root{--card:#ff00ff !important;background-color:#ff00ff !important}"]);
  await assert.rejects(frames({ action: "start" }), /probeplain.view.frames is already started/);
  view.frames.shift()();
  view.observers[0].callback([{ target: view.document.documentElement }]);
  view.frames.shift()(16);
  assert.deepEqual(traces.map(([event, fields]) => [event, fields.width, fields.height]), [["view.content_frame", 240, 400]]);
  assert.deepEqual(await frames({ action: "stop" }), { enabled: false });
  assert.deepEqual(view.document.adoptedStyleSheets, []);
  assert.equal(view.observers[0].disconnected, true);
  await assert.rejects(frames({ action: "stop" }), /probeplain.view.frames is not started/);
  await assert.rejects(frames({ action: "pause" }), /action must be start or stop/);
});

test("the marker color skips a candidate within 4 of a theme color and fails on a theme color that is not #rrggbb", () => {
  assert.deepEqual(markerColorOf(fakeView({ "--card": "#fd02fb" })), [0, 255, 255]);
  assert.throws(() => markerColorOf(fakeView({ "--rule": "rgb(1, 2, 3)" })), /requires the theme color --rule as #rrggbb/);
});
