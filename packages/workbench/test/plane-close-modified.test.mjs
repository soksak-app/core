// The close boundary consumes a surface's modified report; a successful save reply alone does not make a tab clean
// (docs/spec/plugins.md#tab-reports). The surface command is controlled here while the plane and reports are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerPlugin } from "../registry.js";

const behaviorName = "modified tabs require a clean save before tab or window closure";
const pluginId = "fixture-close-modified";
const saveName = `${pluginId}.save`;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test(behaviorName, { timeout: 5000 }, async (t) => {
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
  t.after(() => dom.window.close());
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener() {}, removeEventListener() {} });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: dom.window.CSS,
    PointerEvent: dom.window.PointerEvent, MouseEvent: dom.window.MouseEvent })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => before ? Object.defineProperty(globalThis, name, before) : delete globalThis[name]);
  }
  // JSDOM has no layout engine and does not load the application stylesheet.
  const element = document.getElementById("plane");
  Object.defineProperty(element, "clientWidth", { value: 800 });
  Object.defineProperty(element, "clientHeight", { value: 600 });
  const style = document.createElement("style");
  style.textContent = ".card { --bw: 1px; --divider: 1px; }";
  document.head.appendChild(style);

  const logged = [];
  const actualHost = await import("../host.js");
  t.mock.module("../host.js", { exports: { ...actualHost, report: (line) => logged.push(line) } });
  const surface = (surfaceId) => ({ module: "/fixture.js", composition: { kind: "dom" }, surfaceId,
    pluginId, declarations: {}, sidecars: [] });
  t.mock.module("../surface-modules.js", { exports: {
    mountedSurface: () => null, surfaceForTab: (tab) => surface(tab.id),
    mountSurface: async () => {}, disposeSurface: async () => {}, focusSurface: () => true,
    placePluginPlaceholder: (slot, id, placeholder) => slot.append(placeholder),
  } });
  t.mock.module("../environment.js", { exports: {
    refusedPlugins: () => new Set(),
    environment: () => ({ workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: pluginId, title: "document" }, { plugin: pluginId, title: "other" },
      ] },
    ] } } }),
    pluginUnits: () => [{ id: pluginId, name: "Fixture", description: "Fixture surface.", surface: true, sections: [] }],
  } });
  registerPlugin({ id: pluginId, name: "Fixture", mark: "f", svg: "<path/>", ink: null,
    background: null, drop: null, save: saveName, surface });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const reports = await import("../tab-reports.js");
  const plane = await import("../plane.js");
  let reply = null;
  const saves = [];
  t.mock.method(registry, "run", (name, params, tab) => {
    assert.equal(name, saveName);
    assert.deepEqual(params, {});
    assert.ok(reply, "save has a controlled reply");
    saves.push(tab);
    return reply.promise;
  });

  let held = null;
  const decisions = new Set();
  const changed = () => { for (const check of decisions) check(); };
  plane.onLayout((made, draw) => { held = draw; changed(); });
  const stopReports = reports.onTabReports(changed);
  t.after(stopReports);
  const draw = () => { const render = held; held = null; assert.ok(render); render(); };
  const tabs = () => plane.currentGrid().card("main").data.tabs;
  const has = (id) => tabs().some((tab) => tab.id === id);
  const fresh = () => {
    plane.closePicker("fixture reset");
    if (plane.currentGrid()) for (const tab of tabs()) reports.forgetTab(tab.id);
    plane.adopt(plane.fresh(), "spc-aaaaaa");
    draw();
    reply = deferred();
    saves.length = 0;
    logged.length = 0;
    return tabs()[0].id;
  };
  const decision = (id) => new Promise((resolve) => {
    const check = () => {
      if (has(id) && reports.tabError(id) === null) return;
      decisions.delete(check);
      resolve();
    };
    decisions.add(check);
    check();
  });
  const ask = async (id) => {
    assert.deepEqual(await plane.closeTabById(id), { closed: false }, "modified tab close must ask before removing it");
    assert.equal(has(id), true, "asking to close retains the modified tab");
    const picker = plane.pickerState();
    assert.equal(picker.open, true);
    assert.match(picker.title, /저장하지 않은 변경/);
    assert.deepEqual(picker.items.map(({ name }) => name), ["저장하고 닫기", "저장하지 않고 닫기", "닫지 않기"]);
  };

  let id = fresh();
  reports.reportModified(id, true);
  await ask(id);
  plane.pickItem(2);
  assert.equal(has(id), true, "keep preserves the modified tab");
  assert.equal(plane.pickerState().open, false);
  assert.deepEqual(saves, []);

  id = fresh();
  reports.reportModified(id, true);
  await ask(id);
  plane.pickItem(0);
  assert.deepEqual(saves, [id], "save targets the tab that requested closure");
  assert.equal(has(id), true, "a pending save cannot close its tab");
  let decided = decision(id);
  reply.resolve(null);
  await decided;
  assert.equal(has(id), true, "a save reply that leaves unsaved edits must retain the tab");
  assert.equal(reports.tabModified(id), true);
  assert.equal(reports.tabError(id), `저장하지 못했습니다 · ${saveName} left the tab modified`);
  draw();
  assert.ok(logged.some((line) => line.includes(`${saveName} left the tab modified`)), "the refusal reaches the error display log");

  id = fresh();
  reports.reportModified(id, true);
  await ask(id);
  plane.pickItem(0);
  decided = decision(id);
  reply.reject(new Error("write refused"));
  await decided;
  assert.equal(has(id), true, "a failed save must retain the tab");
  assert.equal(reports.tabError(id), `저장하지 못했습니다 · ${saveName}: write refused`);

  id = fresh();
  reports.reportModified(id, true);
  await ask(id);
  plane.pickItem(0);
  decided = decision(id);
  reports.reportModified(id, false);
  assert.equal(has(id), true, "a clean report still waits for the pending save reply");
  reply.resolve(null);
  await decided;
  assert.equal(has(id), false, "a successful clean save closes the tab");
  assert.equal(tabs().length, 1);

  id = fresh();
  assert.deepEqual(await plane.closeTabById(id), { closed: true });
  assert.equal(has(id), false, "an unmodified tab closes without a save or confirmation");
  assert.equal(plane.pickerState().open, false);
  assert.deepEqual(saves, []);

  id = fresh();
  reports.reportModified(id, true);
  let allowed = plane.settleModifiedTabsToClose();
  assert.equal(plane.pickerState().open, true);
  plane.pickItem(0);
  reply.resolve(null);
  assert.equal(await allowed, false, "window closure must be refused when a save leaves unsaved edits");
  assert.equal(has(id), true);
  assert.equal(reports.tabError(id), `저장하지 못했습니다 · ${saveName} left the tab modified`);

  id = fresh();
  reports.reportModified(id, true);
  allowed = plane.settleModifiedTabsToClose();
  plane.pickItem(0);
  reports.reportModified(id, false);
  reply.resolve(null);
  assert.equal(await allowed, true, "a clean completed save permits window closure");
  assert.equal(has(id), true, "window-close permission does not remove the tab itself");
});

test("close boundary owner assertions detect each removed modified-state guard", { timeout: 30000 }, (t) => {
  const source = fileURLToPath(new URL("..", import.meta.url));
  const folder = mkdtempSync(join(tmpdir(), "soksak-close-guards-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const copy = join(folder, "workbench");
  cpSync(source, copy, { recursive: true, filter: (path) => path !== join(source, "node_modules") && path !== join(source, "test") });
  mkdirSync(join(copy, "test"));
  cpSync(fileURLToPath(import.meta.url), join(copy, "test", "plane-close-modified.test.mjs"));
  symlinkSync(join(source, "node_modules"), join(copy, "node_modules"), "dir");
  const planePath = join(copy, "plane.js");
  const original = readFileSync(planePath, "utf8");
  // This is an independent test runner. Inheriting the outer worker context makes Node skip its tests.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ["--test", "--experimental-test-module-mocks", "--test-reporter=tap",
    `--test-name-pattern=^${behaviorName}$`, join(copy, "test", "plane-close-modified.test.mjs")],
  { cwd: copy, env: environment, encoding: "utf8", timeout: 10000 });
  const baseline = run();
  assert.equal(baseline.error, undefined, baseline.error?.message);
  assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
  assert.match(baseline.stdout, /# pass 1\b/);
  const mutations = [
    { name: "close request", before: "if (tabModified(tabId)) {\n    askBeforeClose", after: "if (false) {\n    askBeforeClose",
      assertion: /modified tab close must ask before removing it/ },
    { name: "tab save reply", before: "if (tabModified(t.id)) {\n        reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      after: "if (false) {\n        reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      assertion: /a save reply that leaves unsaved edits must retain the tab/ },
    { name: "window save reply", before: "if (tabModified(t.id)) {\n          reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      after: "if (false) {\n          reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      assertion: /window closure must be refused when a save leaves unsaved edits/ },
  ];
  for (const mutation of mutations) {
    assert.equal(original.split(mutation.before).length - 1, 1, `${mutation.name} has exactly one site`);
    writeFileSync(planePath, original.replace(mutation.before, mutation.after));
    const result = run();
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, `${mutation.name}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, mutation.assertion, `${mutation.name}: the intended owner assertion must fail`);
    assert.match(result.stdout, /ERR_ASSERTION/);
    t.diagnostic(`${mutation.name}: the owner assertion rejected the removed guard`);
  }
});
