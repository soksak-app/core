// The readiness of the tab state store of the start of the project list (docs/spec/projects.md#persistence). The host calls of the page
// are answered by the page-wire case of each test (docs/spec/cases/page-wire/README.md). The case of the first test is selected before the
// modules are imported, because the page reads the host when it imports them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { host, selectPageWire } from "@soksak/runtime";
import { memoryPlacement } from "../memory-placement.js";

const failure = new Error("tab-state startup fixture failed");
const EMPTY = { common: {}, projects: [], open: [] };
let wire = selectPageWire("projects-tab-state-readiness-failed");

// The window of the page: its address, its history and the error event that the page reports failures through.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://soksak.test/index.html" });
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.ErrorEvent = dom.window.ErrorEvent;

const projects = await import("../projects.js");
const successfulProjects = await import("../projects.js?tab-state-open-success");
const { orderedCallsAnswered } = await import("../host.js");
const { HostWorkspaceStore } = await import("../host-store.js");

test("a failed tab-state open rejects drawn placement waiters while the existing tried signal resolves", async () => {
  projects.begin(structuredClone(EMPTY));
  await orderedCallsAnswered();
  const store = new HostWorkspaceStore(host);
  const initialising = projects.initialise(store, () => true);
  const ready = projects.tabStatesOpened().then((result) => {
    if (!result.opened) throw result.error;
  });
  let observed = false;
  let placed = false;
  const saver = { classify: () => {}, place: () => { placed = true; return { surfaces: [], retain: new Set(), unload: [] }; } };
  const record = { drawn: true, surfaces: [] };
  const candidates = [{ id: "hidden-view", plugin: "probe" }];
  const waiters = [1, 2].map(() => memoryPlacement(record, candidates, {
    ready, saver, observe: () => { observed = true; }, start: (entries) => entries,
  }));

  await assert.rejects(initialising, failure);
  assert.deepEqual(await projects.tabStatesOpened(), { opened: false, error: failure });
  await projects.tabStatesReady();
  const results = await Promise.allSettled(waiters);
  assert.deepEqual(results.map(({ status, reason }) => [status, reason]),
    [["rejected", failure], ["rejected", failure]], "tab-state open failure left a drawn placement pending");
  assert.equal(observed, false, "failed startup classified placement candidates");
  assert.equal(placed, false, "failed startup invoked memory saver placement");
  wire.finish();
});

test("a successful tab-state open resolves the placement readiness result", async () => {
  wire = selectPageWire("projects-tab-state-readiness-opened");
  successfulProjects.begin(structuredClone(EMPTY));
  await orderedCallsAnswered();
  const store = new HostWorkspaceStore(host);
  await successfulProjects.initialise(store, () => true);
  assert.deepEqual(await successfulProjects.tabStatesOpened(), { opened: true });
  await successfulProjects.tabStatesReady();
  wire.finish();
});
