import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";
import { validateDiagnostics } from "@soksak/plugin-api";
import { Session } from "@soksak/window-check/app.mjs";
import { ANCHOR_PLUGIN, installedSectionViews, requireSectionDeclarations, SECTION_PLACEMENT, sectionViewDescriptor }
  from "../benchmark/cases/section-view.mjs";

/** A configuration folder whose plugins/installed.json lists `plugins` ({id, enabled, manifest, diagnostics?}). */
function configFolder(t, plugins, format = 3) {
  const configDir = mkdtempSync(join(tmpdir(), "section-view-folder-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  mkdirSync(join(configDir, "plugins"));
  const records = {};
  for (const { id, enabled, manifest, diagnostics } of plugins) {
    const path = join("plugins", id, "0.0.1");
    mkdirSync(join(configDir, path), { recursive: true });
    writeFileSync(join(configDir, path, "plugin.json"), JSON.stringify(manifest));
    if (diagnostics !== undefined) writeFileSync(join(configDir, path, "diagnostics.json"), JSON.stringify(diagnostics));
    records[id] = { version: "0.0.1", path, enabled, sidecars: {} };
  }
  writeFileSync(join(configDir, "plugins", "installed.json"), JSON.stringify({ format, plugins: records, sidecars: {} }));
  return configDir;
}

const section = (id, page) => ({ id, name: id, composition: { kind: "view", page }, height: "fill" });
const single = (value) => ({ type: "string", enum: [value] });
/** The diagnostics declaration of `plugin` for its sections `sections`: the commands of the plugin and one ready status for each section. */
const declared = (plugin, sections) => ({
  module: "ui/diagnostics.js",
  exposes: {
    commands: [`${plugin}.view.frames`, `${plugin}.view.history`].map((name) => ({ name, description: "d.", params: { type: "object" }, result: {} })),
    status: sections.map((id) => ({ name: `${id}.view.ready`, description: "d.",
      schema: readySchema({ content: single(`${id} section`), language: single("plaintext") }) })),
  },
});
/** The schema of a `<section id>.view.ready` status whose `content` and `language` are declared by `fields`. */
function readySchema(fields) {
  return { type: "object", properties: { ready: { type: "boolean" }, ...fields } };
}
/** `view` whose `<section id>.view.ready` status declares the schema `schema`. */
function withReadySchema(view, schema) {
  const exposes = view.diagnostics.exposes;
  return { ...view, diagnostics: { ...view.diagnostics, exposes: { ...exposes,
    status: exposes.status.map((entry) => (entry.name === `${view.section}.view.ready` ? { ...entry, schema } : entry)) } } };
}

test("the declaration of a plugin that has sections and no surface is a valid diagnostics declaration", () => {
  const manifest = { id: "probeplain", sections: [section("probeplain.section", "ui/section.html")] };
  assert.deepEqual(validateDiagnostics(manifest, declared("probeplain", ["probeplain.section"])), declared("probeplain", ["probeplain.section"]));
});

test("the section views are the sections of the enabled installed plugins, or of one plugin, in the order of plugin id and declaration", (t) => {
  const configDir = configFolder(t, [
    { id: "probeplain", enabled: true, manifest: { id: "probeplain", sections: [section("probeplain.section", "ui/section.html"), section("probeplain.second", "ui/second.html")] }, diagnostics: declared("probeplain", ["probeplain.section", "probeplain.second"]) },
    { id: "layoutprobe", enabled: true, manifest: { id: "layoutprobe", surface: {}, sections: [section("layoutprobe.alpha", "ui/section.html")] } },
    { id: "probeclose", enabled: false, manifest: { id: "probeclose", surface: {}, sections: [section("probeclose.list", "ui/list.html")] } },
    { id: "layoutprobe2", enabled: true, manifest: { id: "layoutprobe2", surface: {} } },
  ]);
  const views = installedSectionViews(configDir);
  assert.deepEqual(views.map(({ plugin, section: id, page }) => [plugin, id, page]), [
    ["layoutprobe", "layoutprobe.alpha", "ui/section.html"],
    ["probeplain", "probeplain.section", "ui/section.html"],
    ["probeplain", "probeplain.second", "ui/second.html"],
  ]);
  assert.equal(views[0].diagnostics, null);
  assert.deepEqual(views[1].diagnostics, declared("probeplain", ["probeplain.section", "probeplain.second"]));
  assert.deepEqual(views[1].manifest, { id: "probeplain", sections: [section("probeplain.section", "ui/section.html"), section("probeplain.second", "ui/second.html")] });
  assert.deepEqual(installedSectionViews(configDir, { plugin: "probeplain" }).map(({ section: id }) => id), ["probeplain.section", "probeplain.second"]);
  assert.throws(() => installedSectionViews(configDir, { plugin: "layoutprobe2" }),
    { message: "no enabled installed plugin layoutprobe2 declares a section view" });
  assert.throws(() => installedSectionViews(configDir, { plugin: "probeclose" }),
    { message: "no enabled installed plugin probeclose declares a section view" });
});

test("reading the section views fails on a folder without installed plugins, another format or no section", (t) => {
  const empty = mkdtempSync(join(tmpdir(), "section-view-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => installedSectionViews(empty),
    { message: `${join(empty, "plugins", "installed.json")} does not exist, so no plugin with a section view is installed` });
  const old = configFolder(t, [], 2);
  assert.throws(() => installedSectionViews(old), { message: `${join(old, "plugins", "installed.json")}: format must be 3, not 2` });
  const none = configFolder(t, [{ id: "layoutprobe2", enabled: true, manifest: { id: "layoutprobe2", surface: {} } }]);
  assert.throws(() => installedSectionViews(none), { message: "no enabled installed plugin declares a section view" });
});

test("a section view whose plugin does not declare the three entries of the section-view contract fails with its plugin and section", (t) => {
  const configDir = configFolder(t, [
    { id: "layoutprobe", enabled: true, manifest: { id: "layoutprobe", surface: {}, sections: [section("layoutprobe.alpha", "ui/section.html")] } },
    { id: "probeplain", enabled: true, manifest: { id: "probeplain", sections: [section("probeplain.section", "ui/section.html"), section("probeplain.second", "ui/second.html")] },
      diagnostics: declared("probeplain", ["probeplain.section"]) },
  ]);
  const [layoutprobe, probeplain, second] = installedSectionViews(configDir);
  const failure = (view) => `${view.plugin} section view ${view.section} does not declare ${view.plugin}.view.frames, ` +
    `${view.plugin}.view.history and ${view.section}.view.ready in its diagnostics declaration`;
  assert.throws(() => requireSectionDeclarations(layoutprobe), { message: failure(layoutprobe) });
  assert.deepEqual(requireSectionDeclarations(probeplain), { ...probeplain, content: "probeplain.section section" });
  // The ready status of another section of the plugin does not serve this section.
  assert.throws(() => requireSectionDeclarations(second), { message: failure(second) });
  const withoutReady = { ...probeplain, diagnostics: { ...probeplain.diagnostics, exposes: { commands: probeplain.diagnostics.exposes.commands } } };
  assert.throws(() => requireSectionDeclarations(withoutReady), { message: failure(probeplain) });
  const readyAsCommand = { ...probeplain, diagnostics: { ...probeplain.diagnostics, exposes: { commands: [...probeplain.diagnostics.exposes.commands,
    { name: "probeplain.section.view.ready", description: "d.", params: { type: "object" }, result: {} }] } } };
  assert.throws(() => requireSectionDeclarations(readyAsCommand), { message: failure(probeplain) });
  const pluginStatus = { ...probeplain, diagnostics: { ...probeplain.diagnostics, exposes: { ...probeplain.diagnostics.exposes,
    status: [{ name: "probeplain.view.ready", description: "d.", schema: readySchema({ content: single("probeplain"), language: single("plaintext") }) }] } } };
  assert.throws(() => requireSectionDeclarations(pluginStatus), { message: failure(probeplain) });
});

test("a section view whose ready status does not declare a single-entry enum content fails with its plugin, section and field", (t) => {
  const configDir = configFolder(t, [
    { id: "probeplain", enabled: true, manifest: { id: "probeplain", sections: [section("probeplain.section", "ui/section.html")] }, diagnostics: declared("probeplain", ["probeplain.section"]) },
  ]);
  const [probeplain] = installedSectionViews(configDir);
  const failure = `probeplain section view probeplain.section declares probeplain.section.view.ready without a single-entry enum content`;
  const language = { language: single("plaintext") };
  assert.throws(() => requireSectionDeclarations(withReadySchema(probeplain, readySchema(language))), { message: failure });
  assert.throws(() => requireSectionDeclarations(withReadySchema(probeplain, readySchema({}))), { message: failure });
  assert.throws(() => requireSectionDeclarations(withReadySchema(probeplain, readySchema({ content: { type: "string" } }))), { message: failure });
  assert.throws(() => requireSectionDeclarations(withReadySchema(probeplain, readySchema({ content: { type: "string", enum: ["one", "two"] } }))),
    { message: failure });
  assert.throws(() => requireSectionDeclarations(withReadySchema(probeplain, { type: "object" })), { message: failure });
  assert.deepEqual(requireSectionDeclarations(withReadySchema(probeplain, readySchema({ content: single("probeplain section") }))).content, "probeplain section",
    "a ready status without a language is refused");
});

test("a section view whose installed declaration the workbench refuses fails with the refusal of validateDiagnostics", (t) => {
  const manifest = { id: "probeplain", sections: [section("probeplain.section", "ui/section.html")] };
  const view = (diagnostics, plugin = manifest) => {
    const configDir = configFolder(t, [{ id: "probeplain", enabled: true, manifest: plugin, diagnostics }]);
    return installedSectionViews(configDir)[0];
  };
  const refused = (schema) => withReadySchema(view(declared("probeplain", ["probeplain.section"])), schema);
  assert.throws(() => requireSectionDeclarations(refused(readySchema({ content: { type: "string", const: "probeplain section" }, language: single("plaintext") }))),
    { message: "probeplain exposes probeplain.section.view.ready schema.content: unknown field const" });
  assert.throws(() => requireSectionDeclarations(refused({ ...readySchema({ content: single("probeplain"), language: single("plaintext") }), required: ["ready"] })),
    { message: "probeplain exposes probeplain.section.view.ready schema: unknown field required" });
  assert.throws(() => sectionViewDescriptor(refused({ ...readySchema({ content: single("probeplain"), language: single("plaintext") }), required: ["ready"] })),
    { message: "probeplain exposes probeplain.section.view.ready schema: unknown field required" });
  // The manifest that the check reads is the installed plugin.json: a name that it also declares is refused.
  const twice = view(declared("probeplain", ["probeplain.section"]), { ...manifest, exposes: { commands: [declared("probeplain", [])
    .exposes.commands[0]] } });
  assert.throws(() => requireSectionDeclarations(twice), { message: "command probeplain.view.frames is declared twice" });
});

const app = { name: "fixture", configDir: mkdtempSync(join(tmpdir(), "section-view-session-")) };
process.once("exit", () => rmSync(app.configDir, { recursive: true, force: true }));

/** The check session on a client that is connected to the case player of the case `name`; closing the player fails when the case was not played. */
async function play(t, name) {
  const server = await startCasePlayer(`section-view-${name}`);
  t.after(() => server.close());
  const client = await connect({ configDir: server.configDir });
  t.after(() => client.close());
  return { s: new Session(app, client), server };
}

/** The commands that the player received, as [name, params, surface] of each. */
const commands = (server) => server.requests.filter(({ method }) => method === "command.run").map(({ params }) => [params.name, params.params, params.surface]);

/** The failure of a wait that no value satisfies: the case ends it with the close of the connection by the host. */
const unsatisfied = (message) => ({ message: `fixture: ${message} (endpoint connection closed)` });

const anchorTab = (id) => ({ id, plugin: ANCHOR_PLUGIN });
const card = (id, h, tabs, rows = [0, 1]) => ({ id, x: 0, y: 0, w: 400, h, r0: rows[0], r1: rows[1], c0: 0, c1: 1, tabs });

test("the section placement anchors on the preferred card with a layoutprobe tab, else on the first such card", () => {
  const grid = { cards: [card("card-1", 300, [{ id: "plain-1", plugin: "probeplain" }]), card("card-2", 300, [anchorTab("t-2")]),
    card("card-3", 300, [anchorTab("t-3")])] };
  assert.equal(SECTION_PLACEMENT.card(grid, "probeplain", "card-3"), "card-3");
  assert.equal(SECTION_PLACEMENT.card(grid, "probeplain", "card-1"), "card-2");
  assert.equal(SECTION_PLACEMENT.card(grid, "probeplain", undefined), "card-2");
  assert.throws(() => SECTION_PLACEMENT.card({ cards: [grid.cards[0]] }, "probeplain", "card-1"),
    { message: "core.grid has no card with a layoutprobe tab, whose card-left sidebar shows the section view of probeplain" });
});

const open = (s, card, params = { section: "probeplain.section" }) => SECTION_PLACEMENT.open(s, { card, plugin: "probeplain", params });

test("a section view starts in a new layoutprobe card split below the tallest layoutprobe card, as the section of its card-left sidebar", async (t) => {
  const { s, server } = await play(t, "open");
  assert.equal(await open(s, "card-1"), "spc-1/card-4:left/probeplain.section");
  await server.played;
  assert.deepEqual(commands(server)[0], ["core.card.split", { card: "card-2", side: "bottom", plugin: "layoutprobe" }, undefined]);
  assert.equal(s.cleanups.length, 1);
  await assert.rejects(open(s, "card-1", {}),
    { message: "the section placement of probeplain requires params.section, the id of the section, not undefined" });
  const absent = await play(t, "open-absent");
  await assert.rejects(open(absent.s, "card-1"),
    unsatisfied("card card-4 did not show the section probeplain.section in its card-left sidebar card-4:left"));
  const noTerminal = await play(t, "open-no-anchor");
  await assert.rejects(open(noTerminal.s, "card-3"),
    { message: "core.grid has no card with a layoutprobe tab to split for the section view of probeplain" });
});

test("a section view that does not start in the fixture state fails with the expected and the actual state before it waits for readiness", async (t) => {
  const started = async (name) => open((await play(t, name)).s, "card-2");
  assert.equal(await started("state-ready"), "spc-1/card-4:left/probeplain.section");
  await assert.rejects(started("state-no-project"),
    { message: "probeplain section view probeplain.section starts with the project test-project, not with no project" });
  await assert.rejects(started("state-other-project"),
    { message: "probeplain section view probeplain.section starts with the project test-project, not with /config/other" });
  await assert.rejects(started("state-plain-active"),
    { message: "probeplain section view probeplain.section starts with a layoutprobe tab active in card card-4, not with probeplain" });
  await assert.rejects(started("state-no-tab"),
    { message: "probeplain section view probeplain.section starts with a layoutprobe tab active in card card-4, not with no active tab" });
});

test("a section view closes with the card that holds its card sidebar", async (t) => {
  const surface = "spc-1/card-4:left/probeplain.section";
  const closed = await play(t, "close");
  await SECTION_PLACEMENT.close(closed.s, surface, { cleanup: false });
  await closed.server.played;
  assert.deepEqual(commands(closed.server), [["core.card.close", { card: "card-4" }, undefined]]);
  const refused = await play(t, "close-refused");
  await assert.rejects(SECTION_PLACEMENT.close(refused.s, surface, { cleanup: true }),
    { message: /^card card-4 of section view spc-1\/card-4:left\/probeplain.section did not close during cleanup\n/ });
  const kept = await play(t, "close-kept");
  await assert.rejects(SECTION_PLACEMENT.close(kept.s, surface, { cleanup: false }), unsatisfied(`section view ${surface} remained registered after close`));
  const lost = await play(t, "close-lost");
  await assert.rejects(SECTION_PLACEMENT.close(lost.s, surface, { cleanup: true }),
    { message: `section view ${surface} is in no card sidebar during cleanup` });
});

test("the section view descriptor waits for its declared ready status and reads its history and frames on its surface", async (t) => {
  const configDir = configFolder(t, [
    { id: "probeplain", enabled: true, manifest: { id: "probeplain", sections: [section("probeplain.section", "ui/section.html")] }, diagnostics: declared("probeplain", ["probeplain.section"]) },
  ]);
  const [view] = installedSectionViews(configDir);
  const descriptor = sectionViewDescriptor(view);
  assert.equal(descriptor.plugin, "probeplain");
  assert.equal(descriptor.placement, SECTION_PLACEMENT);
  assert.deepEqual(descriptor.params, { section: "probeplain.section" });
  assert.equal(descriptor.expectedContent, "probeplain.section section");
  assert.equal(descriptor.readinessStatus, "probeplain.section.view.ready");
  const surface = "spc-1/card-4:left/probeplain.section";
  const content = await play(t, "read-content");
  assert.equal(await descriptor.readContent(content.s, surface), "probeplain.section section",
    "the section view descriptor does not read the content of its ready status");
  assert.deepEqual(content.server.requests.map(({ method, params }) => [method, params.name, params.surface]),
    [["status.get", "probeplain.section.view.ready", surface]]);
  const ready = { ready: true, content: "probeplain.section section", language: "plaintext" };
  const readiness = await play(t, "readiness");
  assert.deepEqual(await descriptor.readiness(readiness.s, surface), { historyEntries: 1, regionHistoryEntries: 0, status: ready });
  await readiness.server.played;
  assert.deepEqual(readiness.server.requests.filter(({ method }) => method === "status.watch").map(({ params }) => [params.name, params.surface]),
    [["core.surfaces", undefined], ["probeplain.section.view.ready", surface]]);
  assert.deepEqual(commands(readiness.server), [["probeplain.view.history", {}, surface]]);
  const other = await play(t, "readiness-content");
  await assert.rejects(descriptor.readiness(other.s, surface),
    { message: /^probeplain section view probeplain.section reported probeplain.section.view.ready on spc-1\/card-4:left\/probeplain.section with content that differs from its declaration\n/ });
  const navigated = await play(t, "readiness-navigated");
  await assert.rejects(descriptor.readiness(navigated.s, surface),
    { message: /^probeplain section view probeplain.section history on spc-1\/card-4:left\/probeplain.section does not contain only its initial document\n/ });
  assert.deepEqual(await descriptor.readDocument((await play(t, "read-document")).s, surface), { historyEntries: 1, regionHistoryEntries: 0 });
  await assert.rejects(descriptor.readDocument((await play(t, "read-document-no-length")).s, surface),
    { message: "probeplain section view probeplain.section answered probeplain.view.history on spc-1/card-4:left/probeplain.section without a length" });
});

test("a section view trace starts and stops the content-frame observer on its surface", async (t) => {
  const configDir = configFolder(t, [
    { id: "probeplain", enabled: true, manifest: { id: "probeplain", sections: [section("probeplain.section", "ui/section.html")] }, diagnostics: declared("probeplain", ["probeplain.section"]) },
  ]);
  const descriptor = sectionViewDescriptor(installedSectionViews(configDir)[0]);
  const surface = "spc-1/card-4:left/probeplain.section";
  const started = { enabled: true, sourceClock: { monoNs: "1" } };
  const s = await play(t, "trace");
  assert.deepEqual(await descriptor.startContentTrace(s.s, surface), started);
  assert.deepEqual(await descriptor.stopContentTrace(s.s, surface), { enabled: false });
  assert.deepEqual(commands(s.server), [["probeplain.view.frames", { action: "start" }, surface], ["probeplain.view.frames", { action: "stop" }, surface]]);
  const unstarted = await play(t, "trace-not-started");
  await assert.rejects(descriptor.startContentTrace(unstarted.s, surface),
    { message: /^probeplain section view probeplain.section content-frame observer did not start on spc-1\/card-4:left\/probeplain.section\n/ });
  assert.equal(unstarted.server.requests.length, 1);
  const running = await play(t, "trace-not-stopped");
  await assert.rejects(descriptor.stopContentTrace(running.s, surface),
    { message: /^probeplain section view probeplain.section content-frame observer did not stop on spc-1\/card-4:left\/probeplain.section\n/ });
});
