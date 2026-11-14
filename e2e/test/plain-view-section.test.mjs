// The section view of the plain view probe (e2e/fixtures/plain-view/probe): its declarations meet the section-view contract of the view
// benchmark, and its diagnostic module serves that contract on a view bridge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { openView } from "@soksak/plugin-api/testing";
import { validateManifest } from "@soksak/plugin-api";
import { requireSectionDeclarations } from "../benchmark/cases/section-view.mjs";
import { attach, declaredText } from "../fixtures/plain-view/probe/ui/section-diagnostics.js";

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

/**
 * Opens the section view of the plain view probe as its entry (ui/section.js) does: the real view bridge and exposure over a jsdom
 * window whose #content shows the declared text, and the diagnostic module attached to them; the wire is the case `wire`. The layout
 * data gives the rectangle of the root of the document.
 */
async function attached(wire) {
  const view = await openView(wire, {
    declarations: diagnostics.exposes,
    html: '<!doctype html><body><p id="content">Plain section</p></body>',
    layout: { width: 240, height: 400, rect: () => ({ left: 0, top: 0, right: 240, bottom: 400, width: 240, height: 400 }) },
    start: { surface: "spc-1/left/probeplain.section", params: null, origin: { directory: null }, project: null,
      section: { id: "probeplain.section", sidebar: "left", card: null } },
  });
  const content = view.window.document.getElementById("content");
  await attach({
    declaration: diagnostics,
    status: STATUS,
    registerStatus: (read, subscribe) => view.expose.status(STATUS, read, subscribe),
    commands: view.bridge.commands,
    view: view.window,
    content,
    log: view.bridge.runtime.log,
  });
  return { view, content };
}

test("the section view is ready while it shows the declared text and answers the length of its session history", { timeout: 5000 }, async () => {
  const { view, content } = await attached("plain-view-section-ready");
  assert.deepEqual(view.calls.filter(({ command }) => command === "runtime.command.register").map(({ params }) => params.name),
    ["probeplain.view.frames", "probeplain.view.history"]);
  assert.deepEqual(await view.status(STATUS), { ready: true, content: "Plain section" });
  content.hidden = true;
  assert.deepEqual(await view.status(STATUS), { ready: false, content: "Plain section" });
  assert.deepEqual(await view.run("probeplain.view.history"), { length: view.window.history.length });
  assert.throws(() => declaredText({ exposes: { status: [] } }, STATUS, "content"), /gives probeplain.section.view.ready no content enum of one string/);
  await view.close();
});

test("the frames start records content frames and the stop ends their observation", { timeout: 5000 }, async () => {
  const { view } = await attached("plain-view-section-frames");
  const started = await view.run("probeplain.view.frames", { action: "start" });
  assert.deepEqual(started, { enabled: true, sourceClock: { documentTimeOriginMs: view.window.performance.timeOrigin, sourceNowMs: started.sourceClock.sourceNowMs, sourceResolutionMs: 1 } });
  assert.ok(started.sourceClock.sourceNowMs > 0, "the source reading is a reading of the clock of the window");
  await assert.rejects(view.run("probeplain.view.frames", { action: "start" }), /probeplain.view.frames is already started/);
  // The observer of the frames is the one that the module made; the size change of the root is delivered to it, and the frame follows.
  const [observer] = view.observers;
  observer.notify([{ target: view.window.document.documentElement }]);
  const record = await view.logged("plugin.probeplain.view.content_frame");
  assert.deepEqual([record.fields.width, record.fields.height], [240, 400]);
  assert.deepEqual(await view.run("probeplain.view.frames", { action: "stop" }), { enabled: false });
  assert.equal(observer.disconnected, true);
  await assert.rejects(view.run("probeplain.view.frames", { action: "stop" }), /probeplain.view.frames is not started/);
  await assert.rejects(view.run("probeplain.view.frames", { action: "pause" }), /action must be start or stop/);
  await view.close();
});
