// The layout probe fixtures (e2e/fixtures/layout-probe/) stand in for real plugins in the layout checks of core
// (docs/spec/plugin-processes.md#verification-boundaries). These tests run their views headless with fake bridges: the manifests
// satisfy the installation contract, the views serve every declared status and register every declared command, the values match
// their declared schemas, and the commands run the tab reports and document changes that the checks observe.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { matchesSchema, normalizeSidebarDefaults, validateManifest, validateReleaseFiles } from "@soksak/plugin-api";

import {
  documentAddress, followedSurface, FOOTER, regionVisibility, startLayoutProbe, startProbeSection,
} from "../fixtures/layout-probe/layoutprobe/ui/layout-probe.js";
import { startDocumentProbe, storageKey } from "../fixtures/layout-probe/layoutprobe/ui/document-probe.js";
import { startSecondProbe } from "../fixtures/layout-probe/layoutprobe2/ui/second-probe.js";

const folder = (plugin) => fileURLToPath(new URL(`../fixtures/layout-probe/${plugin}/`, import.meta.url));
const read = (plugin, file) => JSON.parse(readFileSync(`${folder(plugin)}${file}`, "utf8"));
const probe = read("layoutprobe", "plugin.json");
const second = read("layoutprobe2", "plugin.json");
const schemaOf = (manifest, name) => manifest.exposes.status.find((status) => status.name === name).schema;

/** A fake event target with dispatch. */
function target() {
  const listeners = new Map();
  return {
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    dispatch: (type, event = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); },
  };
}

/** A fake view window with the start values start. */
function fakeView(start, { width = 640, height = 400 } = {}) {
  const view = target();
  const document = target();
  document.visibilityState = "visible";
  document.documentElement = { style: { colorScheme: "dark" } };
  document.body = { style: {}, background: "rgb(30, 30, 30)" };
  const element = { getBoundingClientRect: () => ({ left: 8, top: 8, width: view.innerWidth - 16, height: view.innerHeight - 16 }) };
  document.getElementById = (id) => (id === "document" ? element : null);
  return Object.assign(view, {
    sokSurface: start, document, innerWidth: width, innerHeight: height, devicePixelRatio: 2,
    getComputedStyle: (node) => ({ backgroundColor: node.background }),
  });
}

/** A fake view bridge that records the view calls, the registered commands, the region and the status watches. */
function fakeBridge({ settings = { shade: "plain", rows: 4, caption: "probe" } } = {}) {
  const calls = [];
  const commands = new Map();
  const watches = new Map();
  const region = { posts: [], loads: [], onMessage: null };
  let theme = null;
  let settingsListener = null;
  const bridge = {
    calls: { request: async (name, params) => { calls.push([name, params]); return null; } },
    commands: { register: async (name, run) => { commands.set(name, run); } },
    composition: {
      create: async ({ regions }) => {
        assert.deepEqual(Object.keys(regions), ["page"]);
        return { region: (name) => {
          assert.equal(name, "page");
          return {
            onMessage: (listener) => { region.onMessage = listener; return () => {}; },
            post: async (message) => { region.posts.push(message); },
            load: async (url) => { region.loads.push(url); },
          };
        } };
      },
    },
    runtime: {
      theme: (listener) => { theme = listener; },
      settings: { read: async () => settings, on: async (listener) => { settingsListener = listener; return () => {}; } },
      status: {
        watch: (name, listener, { surface } = {}) => {
          const key = JSON.stringify([name, surface ?? null]);
          watches.set(key, listener);
          return () => watches.delete(key);
        },
      },
    },
  };
  return { bridge, calls, commands, watches, region, theme: (value) => theme(value), settings: (value) => settingsListener(value) };
}

/** A fake exposure that keeps each served status. */
function fakeExpose() {
  const served = new Map();
  return { served, expose: { status: async (name, readValue, subscribe) => { served.set(name, { read: readValue, subscribe }); } } };
}

const TAB_START = Object.freeze({
  surface: "tab-7", params: { path: "notes/a.lprobe" }, origin: { directory: null },
  project: { id: "prj-1", root: "/work/project" }, section: null,
});

async function startTab(start = TAB_START) {
  const view = fakeView(start);
  const fake = fakeBridge();
  const { served, expose } = fakeExpose();
  await startLayoutProbe({ bridge: fake.bridge, expose, view });
  return { view, fake, served };
}

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

test("the tab view and a section view together serve every declared status and register every declared command", { timeout: 1000 }, async () => {
  const { fake, served } = await startTab();
  const section = fakeExpose();
  await startProbeSection({ bridge: fakeBridge().bridge, expose: section.expose,
    view: fakeView({ surface: "spc-1/right/layoutprobe.alpha", params: null, origin: { directory: null }, project: null,
      section: { id: "layoutprobe.alpha", sidebar: "right", card: null } }) });
  assert.deepEqual([...served.keys(), ...section.served.keys()].sort(), probe.exposes.status.map((status) => status.name).sort());
  assert.deepEqual([...fake.commands.keys()].sort(), probe.exposes.commands.map((command) => command.name).sort());
  for (const [name, entry] of [...served, ...section.served]) {
    assert.ok(matchesSchema(schemaOf(probe, name), entry.read()), `${name}: ${JSON.stringify(entry.read())}`);
  }
});

test("the tab view reports its start values, declares its footer and loads its region document", { timeout: 1000 }, async () => {
  const { fake, served } = await startTab();
  assert.deepEqual(fake.calls, [["tab.footer", FOOTER]]);
  assert.deepEqual(fake.region.loads, [documentAddress("tab-7")]);
  assert.equal(documentAddress("spc-1/left/x"), "soksak://layoutprobe/ui/document.html?key=spc-1%2Fleft%2Fx");
  assert.deepEqual(served.get("layoutprobe.view").read(), {
    surface: "tab-7", params: { path: "notes/a.lprobe" }, path: "notes/a.lprobe", origin: { directory: null },
    project: { id: "prj-1", root: "/work/project" }, directory: "/work/project",
    settings: { shade: "plain", rows: 4, caption: "probe" }, title: null, footer: FOOTER, reported: null, notice: null,
  });
  assert.deepEqual(served.get("layoutprobe.surface").read(), {
    width: 640, height: 400, scale: 2, region: { x: 8, y: 8, width: 624, height: 384 }, visibility: "visible",
    theme: { scheme: "dark", background: "rgb(30, 30, 30)" },
  });
  // A tab opened from a tab that recorded a directory starts there, and a tab without params has no path.
  const opened = await startTab({ ...TAB_START, params: null, origin: { directory: "/work/project/sub" } });
  assert.equal(opened.served.get("layoutprobe.view").read().directory, "/work/project/sub");
  assert.equal(opened.served.get("layoutprobe.view").read().path, null);
  const bare = await startTab({ ...TAB_START, project: null, origin: { directory: null } });
  assert.equal(bare.served.get("layoutprobe.view").read().directory, null);
});

test("the tab report commands run their view calls and the view status follows them", { timeout: 1000 }, async () => {
  const { fake, served } = await startTab();
  const status = served.get("layoutprobe.view");
  const values = [];
  status.subscribe((value) => values.push(value));
  assert.equal(await fake.commands.get("layoutprobe.title")({ text: "Probe title" }), null);
  await fake.commands.get("layoutprobe.footer")({ text: "Other footer" });
  await fake.commands.get("layoutprobe.directory")({ path: "/work/project/deep" });
  await fake.commands.get("layoutprobe.notify")({ text: "Done" });
  await fake.commands.get("layoutprobe.notify")({ text: "Posted", policy: "system" });
  await fake.commands.get("layoutprobe.title")({ text: null });
  fake.settings({ shade: "strong", rows: 9, caption: "x" });
  assert.deepEqual(fake.calls.slice(1), [
    ["tab.title", "Probe title"], ["tab.footer", "Other footer"], ["tab.directory", "/work/project/deep"],
    ["tab.notify", { text: "Done", policy: "tab" }], ["tab.notify", { text: "Posted", policy: "system" }], ["tab.title", null],
  ]);
  const last = status.read();
  assert.equal(last.title, null);
  assert.equal(last.footer, "Other footer");
  assert.equal(last.reported, "/work/project/deep");
  assert.deepEqual(last.notice, { text: "Posted", policy: "system" });
  assert.deepEqual(last.settings, { shade: "strong", rows: 9, caption: "x" });
  assert.equal(values.length, 7);
  assert.ok(matchesSchema(schemaOf(probe, "layoutprobe.view"), last));
});

test("a refused tab report leaves the view status unchanged and fails the command", { timeout: 1000 }, async () => {
  const { fake, served } = await startTab();
  fake.bridge.calls.request = async (name) => { throw new Error(`${name} refused`); };
  await assert.rejects(fake.commands.get("layoutprobe.title")({ text: "\u0007" }), /tab.title refused/);
  assert.equal(served.get("layoutprobe.view").read().title, null);
});

test("the document status follows the messages of the region document and the visibility of the view", { timeout: 1000 }, async () => {
  const { view, fake, served } = await startTab();
  const status = served.get("layoutprobe.document");
  assert.deepEqual(status.read(), { url: documentAddress("tab-7"), reported: false, scheme: null, document: null,
    visibility: null, stored: null, color: null });
  // The view receives its own posts as document messages too, and they carry no from mark.
  fake.region.onMessage({ to: "layoutprobe.document", color: "red" });
  assert.equal(status.read().reported, false);
  fake.region.onMessage({ from: "layoutprobe.document", scheme: "light", visibility: "visible", stored: "kept", color: "rgb(0, 128, 96)" });
  assert.deepEqual(status.read(), { url: documentAddress("tab-7"), reported: true, scheme: "light", document: "visible",
    visibility: "shown", stored: "kept", color: "rgb(0, 128, 96)" });
  fake.region.onMessage({ from: "layoutprobe.document", scheme: "dark", visibility: "hidden", stored: "kept", color: "rgb(0, 128, 96)" });
  assert.equal(status.read().visibility, "occluded");
  view.document.visibilityState = "hidden";
  view.document.dispatch("visibilitychange");
  assert.equal(status.read().visibility, "hidden");
  assert.equal(served.get("layoutprobe.surface").read().visibility, "hidden");
  assert.ok(matchesSchema(schemaOf(probe, "layoutprobe.document"), status.read()));
  assert.deepEqual([regionVisibility("visible", null), regionVisibility("hidden", "visible"), regionVisibility("visible", "visible")],
    [null, "hidden", "shown"]);

  await fake.commands.get("layoutprobe.document.color")({ color: "rgb(200, 0, 0)" });
  await fake.commands.get("layoutprobe.document.store")({ value: "site value" });
  assert.deepEqual(fake.region.posts, [{ to: "layoutprobe.document", color: "rgb(200, 0, 0)" }, { to: "layoutprobe.document", store: "site value" }]);
  await assert.rejects(fake.commands.get("layoutprobe.document.color")({ color: "" }), /requires a color/);
  await assert.rejects(fake.commands.get("layoutprobe.document.store")({ value: 3 }), /requires a string value/);
});

test("the surface status follows a resize and a theme of the view", { timeout: 1000 }, async () => {
  const { view, fake, served } = await startTab();
  view.innerWidth = 300;
  view.dispatch("resize");
  assert.deepEqual(served.get("layoutprobe.surface").read().region, { x: 8, y: 8, width: 284, height: 384 });
  view.document.documentElement.style.colorScheme = "light";
  view.document.body.background = "rgb(250, 250, 250)";
  fake.theme({ scheme: "light", tokens: {} });
  assert.deepEqual(served.get("layoutprobe.surface").read().theme, { scheme: "light", background: "rgb(250, 250, 250)" });
});

test("the follow section follows the surface of core.sidebars and watches the view status only on a layoutprobe surface", { timeout: 1000 }, async () => {
  const sectionSurface = "spc-1/right/layoutprobe.follow";
  const fake = fakeBridge();
  const { served, expose } = fakeExpose();
  await startProbeSection({ bridge: fake.bridge, expose,
    view: fakeView({ surface: sectionSurface, params: null, origin: { directory: null }, project: null,
      section: { id: "layoutprobe.follow", sidebar: "right", card: null } }, { width: 190, height: 72 }) });
  const status = served.get("layoutprobe.section");
  assert.deepEqual(status.read(), { id: "layoutprobe.follow", sidebar: "right", card: null, width: 190, height: 72,
    follows: true, surface: null, view: null });
  const sidebars = (surface) => [{ sidebar: "right", sections: [{ surfaceId: sectionSurface, surface }] }];
  const watch = (name, surface) => fake.watches.get(JSON.stringify([name, surface ?? null]));
  watch("core.surfaces", null)([{ surface: "tab-1", plugin: "layoutprobe" }, { surface: "tab-2", plugin: "layoutprobe2" }]);
  watch("core.sidebars", null)(sidebars("tab-2"));
  assert.equal(status.read().surface, "tab-2");
  assert.equal(watch("layoutprobe.view", "tab-2"), undefined, "a surface of another plugin is not watched");
  watch("core.sidebars", null)(sidebars("tab-1"));
  watch("layoutprobe.view", "tab-1")({ surface: "tab-1", title: "One" });
  assert.deepEqual(status.read().view, { surface: "tab-1", title: "One" });
  watch("core.sidebars", null)(sidebars(null));
  assert.equal(watch("layoutprobe.view", "tab-1"), undefined, "the watch of the earlier surface ends");
  assert.deepEqual([status.read().surface, status.read().view], [null, null]);
  assert.ok(matchesSchema(schemaOf(probe, "layoutprobe.section"), status.read()));
  assert.equal(followedSurface(null, sectionSurface), null);
});

test("a section that does not follow watches no status", { timeout: 1000 }, async () => {
  const fake = fakeBridge();
  const { served, expose } = fakeExpose();
  await startProbeSection({ bridge: fake.bridge, expose,
    view: fakeView({ surface: "spc-1/card-2:left/layoutprobe.fill", params: null, origin: { directory: null }, project: null,
      section: { id: "layoutprobe.fill", sidebar: "card-2:left", card: "card-2" } }) });
  assert.equal(fake.watches.size, 0);
  assert.equal(served.get("layoutprobe.section").read().follows, false);
});

test("the region document reports its scheme, visibility, stored value and color, and applies the posts of the view", { timeout: 1000 }, () => {
  const window = target();
  const document = target();
  const storage = new Map([["layoutprobe.site.tab-7", "before"]]);
  const dark = Object.assign(target(), { matches: true });
  const posted = [];
  Object.assign(document, { visibilityState: "visible", body: { style: {} } });
  Object.assign(window, {
    document, location: { href: "soksak://layoutprobe/ui/document.html?key=tab-7", origin: "soksak://layoutprobe" },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    matchMedia: (query) => { assert.equal(query, "(prefers-color-scheme: dark)"); return dark; },
    getComputedStyle: (node) => ({ backgroundColor: node.style.background ?? "rgb(0, 128, 96)" }),
    postMessage: (message, origin) => { assert.equal(origin, "soksak://layoutprobe"); posted.push(message); },
  });
  startDocumentProbe(window);
  const report = (change) => ({ from: "layoutprobe.document", scheme: "dark", visibility: "visible", stored: "before", color: "rgb(0, 128, 96)", ...change });
  assert.deepEqual(posted, [report()]);
  dark.matches = false;
  dark.dispatch("change");
  document.visibilityState = "hidden";
  document.dispatch("visibilitychange");
  window.dispatch("message", { data: posted.at(-1) });
  window.dispatch("message", { data: { to: "layoutprobe.document", color: "rgb(1, 2, 3)" } });
  window.dispatch("message", { data: { to: "layoutprobe.document", store: "after" } });
  assert.deepEqual(posted.slice(1), [
    report({ scheme: "light" }),
    report({ scheme: "light", visibility: "hidden" }),
    report({ scheme: "light", visibility: "hidden", color: "rgb(1, 2, 3)" }),
    report({ scheme: "light", visibility: "hidden", color: "rgb(1, 2, 3)", stored: "after" }),
  ]);
  assert.equal(storage.get("layoutprobe.site.tab-7"), "after");
  assert.equal(storageKey({ href: "soksak://layoutprobe/ui/document.html" }), "layoutprobe.site.");
});

test("the second probe serves its declared status and follows its size", { timeout: 1000 }, async () => {
  const view = fakeView({ surface: "tab-9", params: null, origin: { directory: null }, project: null, section: null });
  const { served, expose } = fakeExpose();
  await startSecondProbe({ expose, view });
  assert.deepEqual([...served.keys()], second.exposes.status.map((status) => status.name));
  assert.equal(second.sidebars, undefined);
  const status = served.get("layoutprobe2.surface");
  const values = [];
  status.subscribe((value) => values.push(value));
  view.innerHeight = 200;
  view.dispatch("resize");
  assert.deepEqual(values, [{ surface: "tab-9", width: 640, height: 200, scale: 2 }]);
  assert.ok(matchesSchema(schemaOf(second, "layoutprobe2.surface"), status.read()));
});
