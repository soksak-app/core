// The close boundary consumes a surface's modified report; a successful save reply alone does not make a tab clean
// (docs/spec/plugins.md#tab-reports). The plane, the reports and the registry are real; the host answers the save command that the registry
// forwards to the surface through the page-wire case plane-close-modified-session (docs/spec/cases/page-wire/README.md), which holds each
// reply until the test releases it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const behaviorName = "modified tabs require a clean save before tab or window closure";
const pluginId = "fixture-close-modified";
const saveName = `${pluginId}.save`;

// The case is selected before the modules are imported, because the page reads the host when it imports them.
const wire = selectPageWire("plane-close-modified-session");
const drained = () => new Promise((resolve) => setImmediate(resolve));

test(behaviorName, { timeout: 5000 }, async (t) => {
  const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener() {}, removeEventListener() {} });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), CSS: dom.window.CSS,
    PointerEvent: dom.window.PointerEvent, MouseEvent: dom.window.MouseEvent,
    addEventListener: dom.window.addEventListener.bind(dom.window), dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
    ErrorEvent: dom.window.ErrorEvent,
    // The plane aligns itself to the device pixel grid of this scale on every draw (device-grid.js).
    devicePixelRatio: dom.window.devicePixelRatio })) {
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

  // JSDOM has no adoptedStyleSheets, which the page reads when it shows a modal; no sheet is adopted here.
  Object.defineProperty(document, "adoptedStyleSheets", { value: [] });
  // The environment of the page: the plugin with the command that saves its tabs (surface.save), and the card with two tabs.
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [
        { plugin: pluginId, title: "document" }, { plugin: pluginId, title: "other" },
      ] },
    ] } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: pluginId, package: "@fixture/close-modified", version: "0.0.1", manifest: {
    id: pluginId, name: "Fixture", description: "Fixture surface.", mark: "f", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" }, save: saveName },
    exposes: { commands: [{ name: saveName, description: "Saves the tab.", params: { type: "object", properties: {} }, result: { type: "null" } }] },
  } }] }), [], "the fixture environment refused a plugin");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const reports = await import("../tab-reports.js");
  const { installCoreExposure } = await import("../core-exposure.js");
  const plane = await import("../plane.js");
  const { flushEvents } = await import("../page-log.js");
  // The registry of the page connects to the host, so it forwards the command of a surface to the surface.
  await installCoreExposure({
    library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
    drawn: async () => {},
  });
  // The lines that the plane wrote to the application log: the error records of the log batches that the page sent to the host.
  const loggedLines = async () => {
    await flushEvents();
    return wire.calls.filter(({ name, payload }) => name === "log" && payload.action === "batch")
      .flatMap(({ payload }) => payload.events).filter(({ event }) => event === "workbench.record.error")
      .map(({ fields }) => `${fields.where}: ${fields.text}`);
  };
  // The tabs for which the registry forwarded the save command to the surface, in order.
  // The page forwards the command to the surface with the request {id, surface, method, params}.
  let origin = 0;
  const saves = () => wire.calls.slice(origin).filter(({ name }) => name === "exposureForward").map(({ payload }) => payload.surface);
  // The ids of the tabs come from a source that draws successive bytes, so that the case records them.
  let draws = 0;
  const random = (buffer) => { buffer.fill(draws++ % 32); };

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
    plane.adopt(plane.fresh(random), "spc-aaaaaa");
    draw();
    // Each tab of the surface registers the save command that its plugin declares, as the host reports a registration of the surface.
    for (const tab of tabs()) registry.registered({ surface: tab.id, kind: "command", name: saveName });
    origin = wire.calls.length;
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
  assert.deepEqual(saves(), []);

  id = fresh();
  reports.reportModified(id, true);
  await ask(id);
  plane.pickItem(0);
  await drained();
  assert.deepEqual(saves(), [id], "save targets the tab that requested closure");
  assert.equal(has(id), true, "a pending save cannot close its tab");
  let decided = decision(id);
  wire.release();
  await decided;
  assert.equal(has(id), true, "a save reply that leaves unsaved edits must retain the tab");
  assert.equal(reports.tabModified(id), true);
  assert.equal(reports.tabError(id), `저장하지 못했습니다 · ${saveName} left the tab modified`);
  draw();
  assert.ok((await loggedLines()).some((line) => line.includes(`${saveName} left the tab modified`)), "the refusal reaches the error display log");

  id = fresh();
  reports.reportModified(id, true);
  await ask(id);
  plane.pickItem(0);
  await drained();
  decided = decision(id);
  wire.release();
  await decided;
  assert.equal(has(id), true, "a failed save must retain the tab");
  assert.equal(reports.tabError(id), `저장하지 못했습니다 · ${saveName}: write refused`);

  await t.test("a failed save can retry and close the same modified tab", { timeout: 5000 }, async () => {
    const dirty = fresh();
    const other = tabs()[1].id;
    let present = true, closures = 0;
    const observe = () => {
      const current = has(dirty);
      if (present && !current) closures++;
      present = current;
    };
    decisions.add(observe);
    try {
      reports.reportModified(dirty, true);
      await ask(dirty);
      plane.pickItem(0);
      await drained();
      const failed = decision(dirty);
      wire.release();
      await failed;
      assert.equal(has(dirty), true, "the failed attempt must retain the same dirty tab for retry");
      assert.equal(reports.tabModified(dirty), true);
      const failure = `저장하지 못했습니다 · ${saveName}: first write refused`;
      assert.equal(reports.tabError(dirty), failure);
      assert.equal(closures, 0);
      draw();
      assert.ok((await loggedLines()).some((line) => line.includes(failure)), "the failed attempt must remain observable in the error log");

      await ask(dirty);
      plane.pickItem(0);
      await drained();
      assert.deepEqual(saves(), [dirty, dirty], "retry must run save again for the same dirty tab");
      assert.equal(has(dirty), true, "the retry must retain the same tab while its save is pending");
      assert.equal(reports.tabModified(dirty), true);
      assert.equal(reports.tabError(dirty), failure, "starting a retry must not erase the first failure");
      const closed = new Promise((resolve) => {
        const check = () => {
          if (has(dirty)) return;
          decisions.delete(check);
          resolve();
        };
        decisions.add(check);
      });
      // The surface clears its own operation error and reports clean state before its successful reply arrives.
      reports.reportError(dirty, null);
      reports.reportModified(dirty, false);
      assert.equal(has(dirty), true, "a clean retry report must still wait for that retry's reply");
      assert.equal(closures, 0, "the failed attempt must not close the tab during the retry");
      wire.release();
      await closed;
      assert.equal(closures, 1, "the same tab must close exactly once after its retry succeeds");
      assert.deepEqual(tabs().map(({ id }) => id), [other], "save recovery must leave the other tab unchanged");
      assert.equal(reports.tabError(dirty), null);
      reports.reportTitle(other, "still open");
      assert.equal(closures, 1, "a later report must not repeat the recovered close");
      assert.deepEqual(saves(), [dirty, dirty]);
    } finally {
      decisions.delete(observe);
    }
  });

  id = fresh();
  reports.reportModified(id, true);
  await ask(id);
  plane.pickItem(0);
  await drained();
  decided = decision(id);
  reports.reportModified(id, false);
  assert.equal(has(id), true, "a clean report still waits for the pending save reply");
  wire.release();
  await decided;
  assert.equal(has(id), false, "a successful clean save closes the tab");
  assert.equal(tabs().length, 1);

  id = fresh();
  assert.deepEqual(await plane.closeTabById(id), { closed: true });
  assert.equal(has(id), false, "an unmodified tab closes without a save or confirmation");
  assert.equal(plane.pickerState().open, false);
  assert.deepEqual(saves(), []);

  id = fresh();
  reports.reportModified(id, true);
  let allowed = plane.settleModifiedTabsToClose();
  assert.equal(plane.pickerState().open, true);
  plane.pickItem(0);
  await drained();
  wire.release();
  assert.equal(await allowed, false, "window closure must be refused when a save leaves unsaved edits");
  assert.equal(has(id), true);
  assert.equal(reports.tabError(id), `저장하지 못했습니다 · ${saveName} left the tab modified`);

  id = fresh();
  reports.reportModified(id, true);
  allowed = plane.settleModifiedTabsToClose();
  plane.pickItem(0);
  await drained();
  reports.reportModified(id, false);
  wire.release();
  assert.equal(await allowed, true, "a clean completed save permits window closure");
  assert.equal(has(id), true, "window-close permission does not remove the tab itself");
  await flushEvents();
  wire.finish();
});

test("close boundary owner assertions detect missing guards and blocked save recovery", { timeout: 30000 }, (t) => {
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
  const run = () => spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    `--test-name-pattern=^${behaviorName}$`, join(copy, "test", "plane-close-modified.test.mjs")],
  { cwd: copy, env: environment, encoding: "utf8", timeout: 10000 });
  const baseline = run();
  assert.equal(baseline.error, undefined, baseline.error?.message);
  assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
  assert.match(baseline.stdout, new RegExp(`^ok \\d+ - ${behaviorName}$`, "m"));
  assert.match(baseline.stdout, /^\s+ok \d+ - a failed save can retry and close the same modified tab$/m);
  const mutations = [
    { name: "close request", before: "if (tabModified(tabId)) {\n    askBeforeClose", after: "if (false) {\n    askBeforeClose",
      assertion: /modified tab close must ask before removing it/ },
    { name: "tab save reply", before: "if (tabModified(t.id)) {\n        reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      after: "if (false) {\n        reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      assertion: /a save reply that leaves unsaved edits must retain the tab/ },
    { name: "window save reply", before: "if (tabModified(t.id)) {\n          reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      after: "if (false) {\n          reportError(t.id, `저장하지 못했습니다 · ${save} left the tab modified`);",
      assertion: /window closure must be refused when a save leaves unsaved edits/ },
    { name: "save recovery", before: 'if (key === "save") {\n      try {\n        await registry.run(save, {}, t.id);',
      after: 'if (key === "save") {\n      if (tabError(t.id)) return;\n      try {\n        await registry.run(save, {}, t.id);',
      assertion: /retry must run save again for the same dirty tab/ },
  ];
  for (const mutation of mutations) {
    assert.equal(original.split(mutation.before).length - 1, 1, `${mutation.name} has exactly one site`);
    writeFileSync(planePath, original.replace(mutation.before, mutation.after));
    const result = run();
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, `${mutation.name}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, mutation.assertion, `${mutation.name}: the intended owner assertion must fail`);
    assert.match(result.stdout, /ERR_ASSERTION/);
    t.diagnostic(`${mutation.name}: the owner assertion rejected the mutation`);
  }
});
