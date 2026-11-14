// The layout probe fixtures (e2e/fixtures/layout-probe/) are the plugins of the layout checks of core
// (docs/spec/plugin-processes.md#verification-boundaries). These tests run their views headless on the real view bridge and the real
// exposure over a jsdom window (packages/plugin-api/testing.js, whose wire is a view-wire case of docs/spec/cases/view-wire/): the manifests satisfy the installation contract, the views serve every declared
// status and register every declared command, the values match their declared schemas, and the commands run the tab reports and
// document changes that the checks observe.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { matchesSchema, normalizeSidebarDefaults, validateManifest, validateReleaseFiles } from "@soksak/plugin-api";

import {
  documentAddress, followedSurface, FOOTER, regionVisibility, startLayoutProbe, startProbeSection,
} from "../fixtures/layout-probe/layoutprobe/ui/layout-probe.js";
import { openDocumentProbe, storageKey } from "../fixtures/layout-probe/layoutprobe/ui/document-probe.js";
import { startSecondProbe, TEXT_SIZE } from "../fixtures/layout-probe/layoutprobe2/ui/second-probe.js";
import { openView, turn } from "@soksak/plugin-api/testing";

const CASES = new URL("../../docs/spec/cases/view-wire/", import.meta.url);

const folder = (plugin) => fileURLToPath(new URL(`../fixtures/layout-probe/${plugin}/`, import.meta.url));
const read = (plugin, file) => JSON.parse(readFileSync(`${folder(plugin)}${file}`, "utf8"));
const probe = read("layoutprobe", "plugin.json");
const second = read("layoutprobe2", "plugin.json");
const schemaOf = (manifest, name) => manifest.exposes.status.find((status) => status.name === name).schema;

const page = (plugin, file) => readFileSync(`${folder(plugin)}${file}`, "utf8");
const START_COLOR = "rgb(30, 30, 30)";
const DEFAULT_SETTINGS = { shade: "plain", rows: 4, caption: "probe" };

/** The rectangle of the #document element of the probe page, which its style insets by 8 points from each edge of the view. */
const inset = (element) => {
  const { innerWidth, innerHeight } = element.ownerDocument.defaultView;
  return { left: 8, top: 8, right: innerWidth - 8, bottom: innerHeight - 8, width: innerWidth - 16, height: innerHeight - 16 };
};

/** Opens the page of a probe view with the start values `start`; the wire is the case `wire`, and `options` are the size and content of the view. */
function open(wire, plugin, file, start, { width = 640, height = 400, content } = {}) {
  return openView(wire, {
    cases: CASES,
    start, declarations: (plugin === "layoutprobe" ? probe : second).exposes,
    html: page(plugin, file).replace("<body>", `<body style="background: ${START_COLOR}">`),
    layout: { width, height, scale: 2, content, rect: (element) => (element.id === "text"
      ? { left: 8, top: 8, right: 8, bottom: 8, width: 100, height: Number.parseFloat(element.style.fontSize) * 1.25 } : inset(element)) },
  });
}

const TAB_START = Object.freeze({
  surface: "tab-7", params: { path: "notes/a.lprobe" }, origin: { directory: null },
  project: { id: "prj-1", root: "/work/project" }, section: null,
});
const sectionStart = (surface, section) => ({ surface, params: null, origin: { directory: null }, project: null, section });

async function startTab(wire, start = TAB_START, options = {}) {
  const view = await open(wire, "layoutprobe", "ui/page.html", start, options);
  await startLayoutProbe({ bridge: view.bridge, expose: view.expose, view: view.window });
  return view;
}

async function startSection(wire, start, options = {}) {
  const view = await open(wire, "layoutprobe", "ui/section.html", start, options);
  await startProbeSection({ bridge: view.bridge, expose: view.expose, view: view.window });
  return view;
}

const commandsOf = (view) => view.calls.filter(({ command }) => command === "runtime.command.register").map(({ params }) => params.name);
/** The calls of the view other than the ones of its exposure and of its registrations. */
const reports = (view) => view.calls.filter(({ command }) => command.startsWith("tab.")).map(({ command, params }) => [command, params]);
const sectionLeft = sectionStart("spc-1/left/layoutprobe.alpha", { id: "layoutprobe.alpha", sidebar: "left", card: null });

test("the layout probe manifests satisfy the installation contract and only the first declares a window override", { timeout: 1000 }, () => {
  for (const plugin of ["layoutprobe", "layoutprobe2"]) {
    const manifest = read(plugin, "plugin.json");
    assert.doesNotThrow(() => validateManifest(manifest), plugin);
    const pkg = read(plugin, "package.json");
    assert.deepEqual(validateReleaseFiles(pkg), ["plugin.json", "ui"]);
    const pages = [manifest.surface.composition.page, ...(manifest.sections ?? []).map((section) => section.composition.page)];
    for (const page of pages) {
      assert.ok(existsSync(`${folder(plugin)}${page}`), `${plugin} ${page}`);
      assert.match(readFileSync(`${folder(plugin)}${page}`, "utf8"), /^<!doctype html>/i);
    }
  }
  const defaults = normalizeSidebarDefaults({}, [probe, second]);
  assert.deepEqual(defaults.links, [{ place: "window-right", plugin: "layoutprobe", set: "layoutprobe.list" }]);
  assert.deepEqual(defaults.sets.map(({ id, layout, sections }) => ({ id, layout, sections })), [
    { id: "layoutprobe.list", layout: "list", sections: ["layoutprobe.alpha", "layoutprobe.fill", "layoutprobe.follow"] },
    { id: "layoutprobe.tabs", layout: "tabs", sections: ["layoutprobe.alpha", "layoutprobe.beta"] },
  ]);
  assert.deepEqual(probe.sections.map((section) => section.height), [96, 64, "fill", 72]);
  assert.deepEqual(probe.surface.opens.extensions, ["lprobe"]);
  assert.deepEqual(Object.values(probe.settings).map((setting) => setting.type), ["enum", "integer", "string"]);
});

test("the tab view and a section view together serve every declared status and register every declared command", { timeout: 5000 }, async () => {
  const tab = await startTab("layout-probe-fixture-tab-statuses");
  const section = await startSection("layout-probe-fixture-section-statuses", sectionStart("spc-1/right/layoutprobe.alpha", { id: "layoutprobe.alpha", sidebar: "right", card: null }));
  assert.deepEqual([...tab.registered("status"), ...section.registered("status")].sort(), probe.exposes.status.map((status) => status.name).sort());
  assert.deepEqual(commandsOf(tab).sort(), probe.exposes.commands.map((command) => command.name).sort());
  assert.deepEqual(commandsOf(section), ["layoutprobe.open"]);
  for (const [view, names] of [[tab, tab.registered("status")], [section, section.registered("status")]]) {
    for (const name of names) {
      const value = await view.status(name);
      assert.ok(matchesSchema(schemaOf(probe, name), value), `${name}: ${JSON.stringify(value)}`);
    }
  }
  await section.close();
  await tab.close();
});

test("the tab and section views register every command before they serve a status, so a check that waits for its statuses can run its commands", { timeout: 5000 }, async () => {
  const commands = probe.exposes.commands.map((command) => command.name).sort();
  const before = (view) => {
    const entries = view.calls.filter(({ command, params }) => command === "runtime.command.register"
      || (command === "runtime.native.call" && params.name === "registered" && params.payload.kind === "status" && !params.payload.name.startsWith("core.")));
    const names = [];
    return entries.map(({ command, params }) => {
      if (command === "runtime.command.register") names.push(params.name);
      return [command === "runtime.command.register" ? "command" : params.payload.name, [...names].sort()];
    }).filter(([name]) => name !== "command");
  };
  const tab = await startTab("layout-probe-fixture-tab-registration-order");
  assert.deepEqual(before(tab).map(([, names]) => names), tab.registered("status").map(() => commands));
  const section = await startSection("layout-probe-fixture-section-registration-order", sectionLeft);
  assert.deepEqual(before(section), [["layoutprobe.section", ["layoutprobe.open"]]]);
  await section.close();
  await tab.close();
});

test("the tab view reports its start values, declares its footer and loads its region document", { timeout: 5000 }, async () => {
  const view = await startTab("layout-probe-fixture-tab-start-values");
  assert.deepEqual(reports(view), [["tab.footer", FOOTER]]);
  assert.deepEqual(view.calls.filter(({ command }) => command === "document.load").map(({ params }) => params), [{ name: "page", url: documentAddress("tab-7") }]);
  assert.equal(documentAddress("spc-1/left/x"), "soksak://layoutprobe/ui/document.html?key=spc-1%2Fleft%2Fx");
  assert.deepEqual(await view.status("layoutprobe.view"), {
    surface: "tab-7", params: { path: "notes/a.lprobe" }, path: "notes/a.lprobe", origin: { directory: null },
    project: { id: "prj-1", root: "/work/project" }, directory: "/work/project",
    settings: DEFAULT_SETTINGS, title: null, footer: FOOTER, reported: null, notice: null,
  });
  assert.deepEqual(await view.status("layoutprobe.surface"), {
    width: 640, height: 400, scale: 2, region: { x: 8, y: 8, width: 624, height: 384 }, visibility: "visible",
    theme: { scheme: "dark", background: START_COLOR },
  });
  await view.close();
  // A tab opened from a tab that recorded a directory starts there, and a tab without params has no path.
  const opened = await startTab("layout-probe-fixture-tab-start-directory", { ...TAB_START, params: null, origin: { directory: "/work/project/sub" } });
  assert.equal((await opened.status("layoutprobe.view")).directory, "/work/project/sub");
  assert.equal((await opened.status("layoutprobe.view")).path, null);
  await opened.close();
  const bare = await startTab("layout-probe-fixture-tab-start-bare", { ...TAB_START, project: null, origin: { directory: null } });
  assert.equal((await bare.status("layoutprobe.view")).directory, null);
  await bare.close();
});

test("the tab report commands run their view calls and the view status follows them", { timeout: 5000 }, async () => {
  const view = await startTab("layout-probe-fixture-tab-reports");
  await view.exposed("status.watch", { name: "layoutprobe.view" });
  assert.equal(await view.run("layoutprobe.title", { text: "Probe title" }), null);
  await view.run("layoutprobe.footer", { text: "Other footer" });
  await view.run("layoutprobe.directory", { path: "/work/project/deep" });
  await view.run("layoutprobe.notify", { text: "Done" });
  await view.run("layoutprobe.notify", { text: "Posted", policy: "system" });
  await view.run("layoutprobe.title", { text: null });
  view.deliverNotice("settings", { shade: "strong", rows: 9, caption: "x" });
  await turn();
  assert.deepEqual(reports(view).slice(1), [
    ["tab.title", "Probe title"], ["tab.footer", "Other footer"], ["tab.directory", "/work/project/deep"],
    ["tab.notify", { text: "Done", policy: "tab" }], ["tab.notify", { text: "Posted", policy: "system" }], ["tab.title", null],
  ]);
  const last = await view.status("layoutprobe.view");
  assert.equal(last.title, null);
  assert.equal(last.footer, "Other footer");
  assert.equal(last.reported, "/work/project/deep");
  assert.deepEqual(last.notice, { text: "Posted", policy: "system" });
  assert.deepEqual(last.settings, { shade: "strong", rows: 9, caption: "x" });
  // The first value of the watch and one value for each change.
  assert.equal(view.changes("layoutprobe.view").length, 8);
  assert.ok(matchesSchema(schemaOf(probe, "layoutprobe.view"), last));
  await view.close();
});

test("a refused tab report leaves the view status unchanged and fails the command", { timeout: 5000 }, async () => {
  const view = await startTab("layout-probe-fixture-tab-report-refused");
  await assert.rejects(view.run("layoutprobe.title", { text: "\u0007" }), /a tab title must be 1 to 256 characters without control characters/);
  assert.equal((await view.status("layoutprobe.view")).title, null);
  await view.close();
});

test("the document status follows the messages of the region document and the visibility of the view", { timeout: 5000 }, async () => {
  const view = await startTab("layout-probe-fixture-document-status");
  const document = view.window.document;
  const message = (value) => view.deliverNotice("document-message", { document: "page", message: value });
  assert.deepEqual(await view.status("layoutprobe.document"), { url: documentAddress("tab-7"), reported: false, scheme: null, document: null,
    visibility: null, changes: null, stored: null, color: null });
  // The view receives its own posts as document messages too, and they carry no from mark.
  message({ to: "layoutprobe.document", color: "red" });
  assert.equal((await view.status("layoutprobe.document")).reported, false);
  message({ from: "layoutprobe.document", scheme: "light", visibility: "visible", changes: 0, stored: "kept", color: "rgb(0, 128, 96)" });
  assert.deepEqual(await view.status("layoutprobe.document"), { url: documentAddress("tab-7"), reported: true, scheme: "light", document: "visible",
    visibility: "shown", changes: 0, stored: "kept", color: "rgb(0, 128, 96)" });
  message({ from: "layoutprobe.document", scheme: "dark", visibility: "hidden", changes: 1, stored: "kept", color: "rgb(0, 128, 96)" });
  assert.equal((await view.status("layoutprobe.document")).visibility, "occluded");
  assert.equal((await view.status("layoutprobe.document")).changes, 1);
  // The platform reports the visibility of the document: the state is data, the event is the one of the document.
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new view.window.Event("visibilitychange"));
  assert.equal((await view.status("layoutprobe.document")).visibility, "hidden");
  assert.equal((await view.status("layoutprobe.surface")).visibility, "hidden");
  assert.ok(matchesSchema(schemaOf(probe, "layoutprobe.document"), await view.status("layoutprobe.document")));
  assert.deepEqual([regionVisibility("visible", null), regionVisibility("hidden", "visible"), regionVisibility("visible", "visible")],
    [null, "hidden", "shown"]);

  await view.run("layoutprobe.document.color", { color: "rgb(200, 0, 0)" });
  await view.run("layoutprobe.document.store", { value: "site value" });
  assert.deepEqual(view.calls.filter(({ command }) => command === "document.post").map(({ params }) => params),
    [{ name: "page", message: { to: "layoutprobe.document", color: "rgb(200, 0, 0)" } }, { name: "page", message: { to: "layoutprobe.document", store: "site value" } }]);
  await assert.rejects(view.run("layoutprobe.document.color", { color: "" }), /requires a color/);
  await assert.rejects(view.run("layoutprobe.document.store", { value: 3 }), /requires a string value/);
  await view.close();
});

test("the surface status follows a resize and a theme of the view", { timeout: 5000 }, async () => {
  const view = await startTab("layout-probe-fixture-surface-status");
  view.window.innerWidth = 300;
  view.window.dispatchEvent(new view.window.Event("resize"));
  assert.deepEqual((await view.status("layoutprobe.surface")).region, { x: 8, y: 8, width: 284, height: 384 });
  view.window.document.body.style.background = "rgb(250, 250, 250)";
  view.deliverNotice("theme", { scheme: "light", tokens: {} });
  assert.deepEqual((await view.status("layoutprobe.surface")).theme, { scheme: "light", background: "rgb(250, 250, 250)" });
  await view.close();
});

test("the follow section follows the surface of core.sidebars and watches the view status only on a layoutprobe surface", { timeout: 5000 }, async () => {
  const sectionSurface = "spc-1/right/layoutprobe.follow";
  const view = await startSection("layout-probe-fixture-follow-section", sectionStart(sectionSurface, { id: "layoutprobe.follow", sidebar: "right", card: null }), { width: 190, height: 72 });
  assert.deepEqual(await view.status("layoutprobe.section"), { id: "layoutprobe.follow", sidebar: "right", card: null, width: 190, height: 72,
    overflows: false, follows: true, surface: null, view: null });
  const watches = () => view.calls.filter(({ command }) => command === "runtime.status.watch").map(({ params }) => [params.name, params.surface ?? null]);
  const unwatches = () => view.calls.filter(({ command }) => command === "runtime.status.unwatch").map(({ params }) => [params.name, params.surface ?? null]);
  const sidebars = (surface) => [{ sidebar: "right", sections: [{ surfaceId: sectionSurface, surface }] }];
  const deliver = async (name, surface, value) => { view.deliverNotice("status", { name, surface, value }); await turn(); };
  await deliver("core.surfaces", undefined, [{ surface: "tab-1", plugin: "layoutprobe" }, { surface: "tab-2", plugin: "layoutprobe2" }]);
  await deliver("core.sidebars", undefined, sidebars("tab-2"));
  assert.equal((await view.status("layoutprobe.section")).surface, "tab-2");
  assert.deepEqual(watches().filter(([name]) => name === "layoutprobe.view"), [], "a surface of another plugin is not watched");
  await deliver("core.sidebars", undefined, sidebars("tab-1"));
  await deliver("layoutprobe.view", "tab-1", { surface: "tab-1", title: "One" });
  assert.deepEqual((await view.status("layoutprobe.section")).view, { surface: "tab-1", title: "One" });
  await deliver("core.sidebars", undefined, sidebars(null));
  assert.deepEqual(unwatches(), [["layoutprobe.view", "tab-1"]], "the watch of the earlier surface ends");
  const state = await view.status("layoutprobe.section");
  assert.deepEqual([state.surface, state.view], [null, null]);
  assert.ok(matchesSchema(schemaOf(probe, "layoutprobe.section"), state));
  assert.equal(followedSurface(null, sectionSurface), null);
  await view.close();
});

test("a section that does not follow watches no status", { timeout: 5000 }, async () => {
  const view = await startSection("layout-probe-fixture-plain-section", sectionStart("spc-1/card-2:left/layoutprobe.fill", { id: "layoutprobe.fill", sidebar: "card-2:left", card: "card-2" }));
  assert.deepEqual(view.calls.filter(({ command }) => command === "runtime.status.watch"), []);
  assert.equal((await view.status("layoutprobe.section")).follows, false);
  await view.close();
});

test("a section view reports whether its document overflows its view, which shows a scroll bar under the classic scroller style", { timeout: 5000 }, async () => {
  const fitting = await startSection("layout-probe-fixture-section-fitting", sectionLeft, { width: 190, height: 96 });
  assert.equal((await fitting.status("layoutprobe.section")).overflows, false);
  await fitting.close();

  const content = { width: 190, height: 100 };
  const view = await startSection("layout-probe-fixture-section-overflow", sectionLeft, { width: 190, height: 96, content });
  assert.equal((await view.status("layoutprobe.section")).overflows, true, "a content 4 points taller than the view overflows it");
  assert.ok(matchesSchema(schemaOf(probe, "layoutprobe.section"), await view.status("layoutprobe.section")));
  view.window.innerHeight = 100;
  view.window.dispatchEvent(new view.window.Event("resize"));
  const resized = await view.status("layoutprobe.section");
  assert.deepEqual([resized.height, resized.overflows], [100, false]);
  content.width = 200;
  view.window.dispatchEvent(new view.window.Event("resize"));
  assert.equal((await view.status("layoutprobe.section")).overflows, true, "a content wider than the view overflows it");
  await view.close();
});

/**
 * A window on the address of the region document: the posts of the window are collected as they arrive as message events. jsdom has
 * no media query list, so the document takes its color scheme as data (openDocumentProbe); the reaction of the document to the
 * media query of the platform is judged in the end-to-end tier by e2e/document-region.test.mjs.
 */
function documentWindow(storageEntries) {
  const { window } = new JSDOM("<!doctype html><body></body>", { url: "https://layoutprobe.example/ui/document.html?key=tab-7", pretendToBeVisual: true });
  for (const [key, value] of storageEntries) window.localStorage.setItem(key, value);
  window.document.body.style.background = "rgb(0, 128, 96)";
  const posted = [];
  const waiters = new Set();
  window.addEventListener("message", (event) => {
    if (event.data?.from === undefined) return;
    posted.push(event.data);
    for (const waiter of [...waiters]) waiter();
  });
  // Settles when the window received `count` reports of the document in all.
  const reported = (count) => new Promise((resolve) => {
    const check = () => {
      if (posted.length < count) return;
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
  return { window, posted, reported };
}

test("the region document reports its scheme, visibility, stored value and color, and applies the posts of the view", { timeout: 5000 }, async () => {
  const { window, posted, reported } = documentWindow([["layoutprobe.site.tab-7", "before"]]);
  const document = window.document;
  const send = (message) => window.postMessage(message, window.location.origin);
  const probe = openDocumentProbe(window, true);
  const report = (change) => ({ from: "layoutprobe.document", scheme: "dark", visibility: "visible", changes: 0, stored: "before",
    color: "rgb(0, 128, 96)", ...change });
  await reported(1);
  assert.deepEqual(posted, [report()]);
  probe.setDark(false);
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new window.Event("visibilitychange"));
  send({ to: "layoutprobe.document", color: "rgb(1, 2, 3)" });
  send({ to: "layoutprobe.document", store: "after" });
  await reported(5);
  assert.deepEqual(posted.slice(1), [
    report({ scheme: "light" }),
    report({ scheme: "light", visibility: "hidden", changes: 1 }),
    report({ scheme: "light", visibility: "hidden", changes: 1, color: "rgb(1, 2, 3)" }),
    report({ scheme: "light", visibility: "hidden", changes: 1, color: "rgb(1, 2, 3)", stored: "after" }),
  ]);
  // A scheme change is no visibility change, and each visibilitychange counts once.
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new window.Event("visibilitychange"));
  await reported(6);
  assert.deepEqual(posted.at(-1), report({ scheme: "light", changes: 2, color: "rgb(1, 2, 3)", stored: "after" }));
  assert.equal(window.localStorage.getItem("layoutprobe.site.tab-7"), "after");
  assert.equal(storageKey({ href: "soksak://layoutprobe/ui/document.html" }), "layoutprobe.site.");
  window.close();
});

/** Starts the second probe in a view whose line of text is 1.25 times its font size high, on the wire of the case `wire`, which records the text size at the start. */
async function startSecond(wire) {
  const view = await open(wire, "layoutprobe2", "ui/page.html", { surface: "tab-9", params: null, origin: { directory: null }, project: null, section: null });
  await startSecondProbe({ bridge: view.bridge, expose: view.expose, view: view.window });
  const document = view.window.document;
  return { view, text: document.getElementById("text"), empty: document.getElementById("empty") };
}

test("the second probe serves its declared status and elements and follows its size", { timeout: 5000 }, async () => {
  const { view, text, empty } = await startSecond("layout-probe-fixture-second-probe");
  assert.deepEqual(view.registered("status"), second.exposes.status.map((status) => status.name));
  assert.deepEqual(view.registered("element"), second.exposes.element.map((element) => element.name));
  assert.deepEqual([text.dataset.expose, empty.dataset.expose], ["layoutprobe2.text", "layoutprobe2.empty"]);
  assert.equal(second.sidebars, undefined);
  await view.exposed("status.watch", { name: "layoutprobe2.surface" });
  view.window.innerHeight = 200;
  view.window.dispatchEvent(new view.window.Event("resize"));
  await turn();
  assert.deepEqual(view.changes("layoutprobe2.surface").at(-1), { surface: "tab-9", width: 640, height: 200, scale: 2, text: { factor: 1, height: TEXT_SIZE * 1.25 } });
  assert.ok(matchesSchema(schemaOf(second, "layoutprobe2.surface"), await view.status("layoutprobe2.surface")));
  await view.close();
});

test("the second probe draws its text at the text size of its surface and reports each change", { timeout: 5000 }, async () => {
  const { view, text } = await startSecond("layout-probe-fixture-second-probe-text-size");
  assert.equal(text.style.fontSize, `${TEXT_SIZE * 1.25}px`);
  assert.deepEqual((await view.status("layoutprobe2.surface")).text, { factor: 1.25, height: TEXT_SIZE * 1.25 * 1.25 });
  await view.exposed("status.watch", { name: "layoutprobe2.surface" });
  view.deliverNotice("textSize", 1.5);
  await turn();
  assert.equal(text.style.fontSize, `${TEXT_SIZE * 1.5}px`);
  assert.deepEqual(view.changes("layoutprobe2.surface").at(-1).text, { factor: 1.5, height: TEXT_SIZE * 1.5 * 1.25 });
  await view.close();
});

test("the open command of a tab or section view runs core.file.open and answers the tab or the failure", { timeout: 5000 }, async () => {
  const declared = probe.exposes.commands.find((command) => command.name === "layoutprobe.open");
  for (const start of [() => startTab("layout-probe-fixture-open-tab"), () => startSection("layout-probe-fixture-open-section", sectionStart("spc-1/left/layoutprobe.beta", { id: "layoutprobe.beta", sidebar: "left", card: null }))]) {
    const view = await start();
    const opened = await view.run("layoutprobe.open", { path: "notes/b.lprobe" });
    const refused = await view.run("layoutprobe.open", { path: "notes/b.unknown" });
    assert.deepEqual(opened, { tab: "tab-8", error: null });
    assert.deepEqual(refused, { tab: null, error: "no plugin opens notes/b.unknown" });
    assert.deepEqual(view.calls.filter(({ command }) => command === "core.file.open").map(({ params }) => params),
      [{ path: "notes/b.lprobe" }, { path: "notes/b.unknown" }]);
    for (const value of [opened, refused]) assert.ok(matchesSchema(declared.result, value), JSON.stringify(value));
    await assert.rejects(view.run("layoutprobe.open", { path: "" }), /requires a path/);
    await view.close();
  }
});
