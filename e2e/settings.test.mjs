// Checks the sections of the settings window (General, Plugins, Sidebar), creating, editing and deleting a set, and setting the layout values (docs/spec/settings.md).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows } from "@soksak/window-check/event-log.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";

/** Current controls of the settings window. */
const controls = async (s) => (await s.get("core.settings-modal")).controls;

/** Waits until the control is found by name and key. */
async function control(s, name, key) {
  const modal = await s.until("core.settings-modal",
    (value) => value.controls.some((c) => c.name === name && c.key === key), `settings control ${name} ${key} did not appear`);
  return modal.controls.find((c) => c.name === name && c.key === key);
}

/** Runs the command that the control points to. If value is present, it is sent as a value input. */
async function press(s, name, key, value, param = "value") {
  const found = await control(s, name, key);
  assert.ok(found.command, `${name} ${key} has no command`);
  const params = { ...found.command.params };
  if (value !== undefined) params[param] = value;
  return s.run(found.command.name, params);
}

async function section(s, id) {
  await press(s, "core.settings-modal.nav", `nav:${id}`);
  await s.until("core.settings-modal", (modal) => modal.section === id, `settings did not show ${id}`);
}

const settingsValue = async (s, key) => (await s.get("core.settings")).values[key];

for (const app of Object.values(APPS)) {
  test(`${app.name}: terminal card sidebar choices persist through declared controls and reload`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await section(s, "plugins");
    await press(s, "core.settings-modal.plugin", "plugin:terminal");
    const set = (await settingsValue(s, "sets"))[0].id;
    const places = ["card-left", "card-right", "card-top", "card-bottom"];
    for (const place of places) {
      await press(s, "core.settings-modal.set", `link:${place}:terminal`, set, "set");
      await s.until("core.settings", (state) => !state.saving && state.values.links.some((link) =>
        link.place === place && link.plugin === "terminal" && link.set === set), `${place} was not saved`);
    }
    const persisted = JSON.parse(readFileSync(join(app.configDir, "settings.json"), "utf8"));
    assert.deepEqual(persisted.links.filter((link) => link.plugin === "terminal" && places.includes(link.place))
      .map((link) => [link.place, link.set]), places.map((place) => [place, set]));
    await s.run("core.settings.close");
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (state) => state.timeOrigin !== before && state.readyState === "complete",
      "the main document did not reload");
    const restored = await s.until("core.settings", (state) => places.every((place) => state.values.links.some((link) =>
      link.place === place && link.plugin === "terminal" && link.set === set)), "reload lost terminal card sidebar choices");
    assert.equal(restored.saving, false);
  });

  test(`${app.name}: settings keep sidebar appearance in general and list plugins with search and pages`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    const opened = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    const navs = opened.controls.filter((c) => c.name === "core.settings-modal.nav").map((c) => c.key);
    assert.deepEqual(navs, ["nav:general", "nav:plugins", "nav:sidebars"]);

    // General: the sidebar appearance is here and plugin settings are not.
    await section(s, "general");
    await control(s, "core.settings-modal.set", "left");
    await control(s, "core.settings-modal.set", "right");
    await control(s, "core.settings-modal.set", "link:left:");
    for (const key of ["sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth"]) {
      await control(s, "core.settings-modal.set", key);
    }
    const pluginKeys = Object.keys((await s.get("core.settings")).values).filter((key) => key.includes("."));
    const general = (await controls(s)).map((c) => c.key ?? "");
    assert.deepEqual(general.filter((key) => pluginKeys.includes(key)), [], "일반 shows plugin settings");

    // Sidebar: only the set list and a new set are here.
    await section(s, "sidebars");
    const sidebars = (await controls(s)).filter((c) => !["core.settings-modal.nav", "core.settings-modal.scope",
      "core.settings-modal.grip", "core.settings-modal.close"].includes(c.name)).map((c) => c.name);
    assert.deepEqual([...new Set(sidebars)].sort(),
      ["core.settings-modal.create", "core.settings-modal.delete", "core.settings-modal.edit", "core.settings-modal.set-caption"]);

    // Plugins: a search field and a list. The search term filters the list, a row opens a page, and the list returns.
    await section(s, "plugins");
    const list = await s.until("core.settings-modal", (modal) => modal.plugin === null && modal.listed.length > 0,
      "the plugin list did not show");
    // The list holds the enabled installed plugins of the configuration, in the order of their ids.
    const { plugins: installed } = JSON.parse(readFileSync(join(s.app.configDir, "plugins", "installed.json"), "utf8"));
    assert.deepEqual(list.listed, Object.keys(installed).filter((id) => installed[id].enabled).sort());
    assert.equal(list.query, "");
    const rows = list.controls.filter((c) => c.name === "core.settings-modal.plugin");
    assert.deepEqual(rows.map((c) => c.key), list.listed.map((id) => `plugin:${id}`));
    // A row shows only the plugin name. The description and the install actions are on the plugin page of the library (docs/spec/settings.md).
    const names = Object.fromEntries((await s.get("core.plugins")).plugins.map((row) => [row.id, row.name]));
    assert.deepEqual(rows.map((c) => c.label), list.listed.map((id) => names[id]));
    assert.deepEqual(list.controls.filter((c) => c.name === "core.settings-modal.manage").map((c) => c.command),
      [{ name: "core.plugins.browse", params: {} }]);
    await press(s, "core.settings-modal.search", "plugin-search", "TERM", "query");
    await s.until("core.settings-modal", (modal) => modal.query === "TERM" && modal.listed.join() === "terminal",
      "the search did not keep only terminal");
    await press(s, "core.settings-modal.search", "plugin-search", "없는플러그인", "query");
    await s.until("core.settings-modal", (modal) => modal.listed.length === 0, "a query without a match still lists plugins");
    await press(s, "core.settings-modal.search", "plugin-search", "", "query");
    await s.until("core.settings-modal", (modal) => modal.listed.join() === list.listed.join(), "an empty query did not list every plugin");

    await press(s, "core.settings-modal.plugin", "plugin:terminal");
    const terminal = await s.until("core.settings-modal", (modal) => modal.plugin === "terminal", "terminal page did not open");
    assert.deepEqual(terminal.listed, [], "the page still shows the plugin list");
    // There is one row per setting that the manifest declares, in the declaration order. The default values of the plugin settings are registered in that order.
    const declared = Object.keys((await s.get("core.settings")).values).filter((key) => key.startsWith("terminal."));
    assert.deepEqual(terminal.rows.map((row) => row.key), declared, `terminal rows: ${JSON.stringify(terminal.rows)}`);
    assert.deepEqual(terminal.rows.find((row) => row.key === "terminal.cursor.shape"), {
      key: "terminal.cursor.shape", name: "커서 모양",
      description: "block은 칸 전체, underline은 밑줄, beam은 세로 막대로 그린다. 프로그램이 모양을 정하면 그 모양을 쓴다.",
    });
    await control(s, "core.settings-modal.set", "link:window-right:terminal");
    for (const side of ["left", "right", "top", "bottom"]) {
      assert.equal((await control(s, "core.settings-modal.set", `link:card-${side}:terminal`)).value, "off",
        `the missing card-${side} link did not display off`);
    }
    // A choice is a select box regardless of the number of values (Controls in docs/spec/settings.md).
    const shape = await control(s, "core.settings-modal.set", "terminal.cursor.shape");
    assert.deepEqual(shape.options, ["block", "underline", "beam"]);
    await press(s, "core.settings-modal.set", "terminal.cursor.shape", "beam");
    await s.until("core.settings", (value) => value.values["terminal.cursor.shape"] === "beam" && !value.saving,
      "the plugin page did not change terminal.cursor.shape");
    await press(s, "core.settings-modal.back", "plugins:list");
    await s.until("core.settings-modal", (modal) => modal.plugin === null && modal.listed.join() === list.listed.join(), "목록 did not return to the list");
  });

  test(`${app.name}: the settings plugin page has no plugin operation and 플러그인 관리 shows the plugin screen`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(async () => {
      if ((await s.get("core.settings-modal")).open) await s.run("core.settings.close");
      if ((await s.get("core.screen")).screen === "library") {
        await s.run("core.library.page", { page: "projects" });
        await s.run("core.library.return");
      }
    });
    await section(s, "plugins");
    await press(s, "core.settings-modal.plugin", "plugin:files");
    const page = await s.until("core.settings-modal", (modal) => modal.plugin === "files", "files page did not open");
    assert.deepEqual(page.controls.filter((c) => c.command?.name.startsWith("core.plugins.")), [],
      "the settings plugin page still runs plugin operations");
    await press(s, "core.settings-modal.back", "plugins:list");
    await press(s, "core.settings-modal.manage", "plugins:manage");
    await s.until("core.settings-modal", (modal) => !modal.open, "플러그인 관리 did not close the settings window");
    await s.until("core.screen", (screen) => screen.screen === "library", "플러그인 관리 did not show the library");
    await s.until("core.library", (library) => library.page === "plugins" && library.plugins.shown.includes("files"),
      "플러그인 관리 did not show the plugin page");
  });

  test(`${app.name}: each sidebar set line fits beside its buttons on one line`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    await section(s, "sidebars");
    const sets = await settingsValue(s, "sets");
    assert.ok(sets.length > 0, "the check needs a sidebar set");
    for (const [index, set] of sets.entries()) {
      // The height of one line is lower than the edit button of the same row. A line folded into two or more lines is higher than the button.
      const line = await s.rect("core.settings-modal.set-caption", index);
      const edit = await s.rect("core.settings-modal.edit", index);
      assert.ok(line.height <= edit.height,
        `the line of set ${set.id} wraps: ${line.height}px high, ${line.width}px wide, beside a ${edit.height}px edit button`);
    }
  });

  test(`${app.name}: settings create, edit with section rows, and delete a sidebar set`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    await section(s, "sidebars");
    const before = await settingsValue(s, "sets");

    await press(s, "core.settings-modal.create", "sets:create");
    const created = await s.until("core.settings", (value) => value.values.sets.length === before.length + 1 && !value.saving,
      "새 세트 did not add a set");
    const made = created.values.sets.at(-1);
    assert.deepEqual({ title: made.title, layout: made.layout, sections: made.sections },
      { title: "새 세트", layout: "list", sections: [] });
    await s.until("core.settings-modal", (modal) => modal.editing === made.id, "the new set is not being edited");

    await press(s, "core.settings-modal.set", `title:${made.id}`, "검사 세트", "title");
    await press(s, "core.settings-modal.set", `layout:${made.id}`, "tabs", "layout");
    const sectionsOf = async () => (await settingsValue(s, "sets")).find((item) => item.id === made.id).sections;
    const saved = (want, message) => s.until("core.settings", (value) => !value.saving &&
      value.values.sets.find((item) => item.id === made.id)?.sections.join() === want.join(), message);

    // + adds the first registered section that is not in the set. Pressing it three times gives three rows.
    for (let n = 1; n <= 3; n++) {
      await press(s, "core.settings-modal.add", `add:${made.id}`);
      await s.until("core.settings", (value) => !value.saving &&
        value.values.sets.find((item) => item.id === made.id)?.sections.length === n, `+ did not add row ${n}`);
    }
    const three = await sectionsOf();
    assert.equal(new Set(three).size, 3);
    const editor = await s.until("core.settings-modal", (modal) =>
      modal.controls.filter((c) => c.name === "core.settings-modal.row").length === 3, "the editor did not draw three rows");
    // The editor has no control for each registered section. Each row has one select box and ▲▼−, and there is one +.
    assert.equal(editor.controls.filter((c) => c.name === "core.settings-modal.section").length, 0);
    assert.equal(editor.controls.filter((c) => c.name === "core.settings-modal.add").length, 1);
    assert.deepEqual(editor.controls.filter((c) => c.name === "core.settings-modal.row-act").map((c) => c.key), [
      `down:${made.id}:0`, `remove:${made.id}:0`,
      `up:${made.id}:1`, `down:${made.id}:1`, `remove:${made.id}:1`,
      `up:${made.id}:2`, `remove:${made.id}:2`,
    ]);
    const select = editor.controls.find((c) => c.key === `row:${made.id}:0`);
    assert.equal(select.value, three[0]);
    assert.deepEqual(select.groups.map((g) => g.label), ["브라우저", "파일"]);
    assert.equal(select.groups.flatMap((g) => g.values).length, 6);

    await press(s, "core.settings-modal.row-act", `down:${made.id}:0`);
    await saved([three[1], three[0], three[2]], "▼ did not move row 0 down");
    await press(s, "core.settings-modal.row-act", `up:${made.id}:2`);
    await saved([three[1], three[2], three[0]], "▲ did not move row 2 up");
    await press(s, "core.settings-modal.row-act", `remove:${made.id}:1`);
    await saved([three[1], three[0]], "− did not remove row 1");
    await press(s, "core.settings-modal.row", `row:${made.id}:0`, "files.bookmarks", "section");
    await saved(["files.bookmarks", three[0]], "the select box did not replace row 0");
    await assert.rejects(press(s, "core.settings-modal.row", `row:${made.id}:1`, "files.bookmarks", "section"),
      new RegExp(`section files.bookmarks is already in set ${made.id}`));
    assert.deepEqual(await sectionsOf(), ["files.bookmarks", three[0]], "a rejected repeat changed the set");

    await press(s, "core.settings-modal.edit", "edit:");
    await s.until("core.settings-modal", (modal) => modal.editing === null, "완료 did not close the editor");
    await s.run("core.settings.link", { place: "left", plugin: null, set: made.id, scope: "common" });
    await s.until("core.settings", (value) => !value.saving && value.values.links.some((l) => l.set === made.id),
      "the set was not linked");
    await press(s, "core.settings-modal.delete", `delete:${made.id}`);
    const deleted = await s.until("core.settings", (value) => !value.saving && !value.values.sets.some((item) => item.id === made.id),
      "삭제 did not remove the set");
    assert.ok(!deleted.values.links.some((l) => l.set === made.id), "deleting the set kept its link");
  });

  test(`${app.name}: layout value settings change the inset sidebar widths`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    await s.run("core.settings.set", { patch: { sidebarWidth: 150, sidebarMinWidth: 140 }, scope: "common" });
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left?.size === 150),
      "an internal card sidebar did not open at sidebarWidth");
    const card = grid.cards.find((item) => item.sidebars?.left);
    await assert.rejects(s.run("core.card.sidebar.size", { card: card.id, side: "left", size: 130 }), /140 to 480/);
    await assert.rejects(s.run("core.settings.set", { patch: { sidebarMinWidth: 200 }, scope: "common" }),
      /sidebarMinWidth .*sidebarWidth .*sidebarMaxWidth/);
  });

  test(`${app.name}: an invalid stored set or link is rejected when it is changed and when it is loaded`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const sets = await settingsValue(s, "sets");
    // A section that the loaded files plugin does not declare is rejected.
    const broken = sets.map((item, index) => (index === 0 ? { ...item, sections: [...item.sections, "files.gone"] } : item));
    await assert.rejects(s.run("core.settings.set", { patch: { sets: broken }, scope: "common" }),
      /names unknown section files.gone/);
    await assert.rejects(s.run("core.settings.set", { patch: { links: [{ place: "left", plugin: null, set: "set-none" }] }, scope: "common" }),
      /known set/);
    assert.deepEqual(await settingsValue(s, "sets"), sets, "a rejected change altered the sets");
    // A section of a plugin that is not loaded stays in the set (docs/spec/plugins.md).
    const kept = sets.map((item, index) => (index === 0 ? { ...item, sections: [...item.sections, "gone.section"] } : item));
    await s.run("core.settings.set", { patch: { sets: kept }, scope: "common" });
    assert.deepEqual(await settingsValue(s, "sets"), kept, "a set naming a section of a plugin that is not loaded was not kept");
    await s.run("core.settings.set", { patch: { sets }, scope: "common" });

    // If a set holds a section that is not registered in the project settings file, the command that opens that project is rejected with that error.
    // The caller that received the rejection reports the failure once (docs/spec/settings.md).
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-sets-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".soksak"), { recursive: true });
    writeFileSync(join(root, ".soksak/settings.json"), JSON.stringify({ sets: broken }));
    // The invalid set that this check saved is also reported as a page error every time the settings of that project are reloaded.
    s.expectError(/settings: set .* names unknown section files\.gone/);
    await s.run("core.settings.set", { patch: { projectOpening: "tabs" }, scope: "common" });
    const opened = s.run("core.project.open", { root, color: "#7fe3b0" }).catch((error) => error);
    s.cleanup(async () => {
      for (const item of await s.get("core.projects")) {
        if (item.root === root) await s.run("core.project.close", { id: item.id });
      }
    });
    const refused = await opened;
    assert.ok(refused instanceof Error, "opening a project with an invalid stored set did not fail");
    assert.match(refused.message, /settings: set .* names unknown section files\.gone/);
  });

  test(`${app.name}: a plugin's right sidebar choice takes precedence over the general choice`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const right = async (card, want, message) => {
      await s.run("core.card.focus", { card });
      await s.until("core.sidebars", (bars) => (bars.find((bar) => bar.sidebar === "right")?.set ?? null) === want, message);
    };
    // A general choice is place right and a plugin override is place window-right. off removes that connection.
    const general = (set) => s.run("core.settings.link", { place: "right", plugin: null, set, scope: "common" });
    const override = (plugin, set) => s.run("core.settings.link", { place: "window-right", plugin, set, scope: "common" });
    // The default has no general choice. An override set-install is placed on the terminal.
    await override("terminal", "set-install");
    await right("terminal", "set-install", "the terminal override did not show while no general choice exists");
    // Even if a general set exists, the override of the focused plugin takes precedence.
    await general("set-page");
    await right("terminal", "set-install", "the general set replaced the terminal override");
    // Removing the override reveals the general set.
    await override("terminal", "off");
    await right("terminal", "set-page", "removing the terminal override did not show the general set");
    await right("browser", "set-browser", "the browser override did not take precedence over the general set");
    await assert.rejects(general("inherit"), /inherit/);
    await assert.rejects(override("browser", "inherit"), /inherit/);
  });

  test(`${app.name}: a card-left link draws an internal card sidebar and no rail column`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left),
      "no card holds an internal sidebar after a card-left link");
    assert.equal(grid.cards.some((card) => card.id.startsWith("rail-")), false, "a rail column stands in a fresh configuration");
    // There is no position setting for the card sidebar. There are only the fixed window sidebar and the sidebar inside the card.
    assert.equal(Object.hasOwn((await s.get("core.settings")).values, "cardSidebar"), false);
    await assert.rejects(s.run("core.settings.set", { patch: { cardSidebar: "inset" }, scope: "common" }), /Unknown setting: cardSidebar/);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await section(s, "general");
    assert.deepEqual((await controls(s)).filter((c) => c.key === "cardSidebar"), [], "일반 shows a card sidebar position");
  });

  test(`${app.name}: performance tracing records enabled card focus and stops while disabled`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    // The host uses the path in which the symbolic link of the configuration directory is resolved.
    const config = realpathSync(app.configDir);
    const services = join(config, "services");
    // The process of the host holds the switch: the switch writes no file of the configuration folder and no flag into a
    // service directory (docs/spec/performance-trace.md#the-switch). A file that an earlier build left stays as it was.
    const switchFiles = () => Object.fromEntries([join(config, "performance"), join(config, "logs", "performance.ndjson"),
      ...(existsSync(services) ? readdirSync(services, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => join(services, entry.name, "performance")) : [])]
      .filter((path) => existsSync(path)).map((path) => [path, statSync(path).mtimeMs]));
    // The events of the trace of the page and of the host are in the event log. The switch controls the events below; the
    // entrances that always record (host.endpoint.call, host.test.mark) and a sidecar, which stores its events in its own
    // file whether or not the trace is on (docs/spec/performance-trace.md), are not output of the switch.
    const SWITCHED = ["page.trace.", "host.trace.", "host.sampler."];
    const traced = async (offsets) => {
      await s.flushLog();
      const switched = readEvents(config, offsets).events.filter((event) =>
        SWITCHED.some((prefix) => event.event.startsWith(prefix)));
      return traceRows(switched);
    };
    const change = (enabled) => s.run("core.settings.set", {
      scope: "common", patch: { "diagnostics.performance": enabled },
    });
    await change(false);
    const files = switchFiles();
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.length).id;
    const before = currentEventOffsets(config);
    await s.run("core.card.focus", { card });
    assert.deepEqual(await traced(before), [], "disabled focus changed the trace output");
    await change(true);
    assert.deepEqual(switchFiles(), files, "enabling the trace wrote a file or a service flag");
    await s.run("core.card.focus", { card });
    await change(false);
    assert.deepEqual(switchFiles(), files, "disabling the trace wrote a file or a service flag");
    const events = await traced(before);
    const after = currentEventOffsets(config);
    assert.ok(events.some((line) => line.layer === "page" && line.event === "action"
      && line.kind === "card.focus" && line.card === card), "enabled focus action was not recorded");
    assert.ok(events.some((line) => line.layer === "page" && line.event === "command"
      && line.name === "core.card.focus" && line.ok === true), "enabled focus command was not recorded");
    await s.run("core.card.focus", { card });
    assert.deepEqual(await traced(after), [], "focus after disable changed the trace output");
  });

  test(`${app.name}: a new inset sidebar opens at 190 points`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left),
      "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebars?.left);
    assert.equal(card.sidebars.left.size, 190);
    assert.equal(card.sidebars.left.collapsed, false);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a settings change keeps the scroll position of the window`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const dim = (await s.get("core.settings")).values.dim;
    s.cleanup(async () => {
      await s.run("core.settings.set", { patch: { dim }, scope: "common" });
      await s.run("core.settings.close");
    });
    await s.run("core.settings.open");
    const { card } = await s.until("core.settings-modal", (modal) => modal.open && modal.scroll === 0,
      "the settings window did not open at its top");
    // The wheel goes to the displayed modal web view. A wheel before the display goes to the main page.
    await s.until("host.window", (w) => w.modal?.id === "settings" && w.modal.shown, "the settings window was not shown");
    // Scrolls the General section down. The native window reports the position.
    await s.pointer(card.x + card.w / 2, card.y + card.h / 2, "scroll", { deltaY: 240 });
    const { scroll } = await s.until("core.settings-modal", (modal) => modal.scroll > 0, "the settings window did not scroll");
    // Changing a value redraws the window. The content stays the same after the redraw, so the position is kept.
    const drawn = await s.collect("core.settings-modal");
    await s.run("core.settings.change", { key: "dim", value: String(!dim), scope: "common" });
    await s.until("core.settings", (value) => value.values.dim === !dim && !value.saving, "the setting did not change");
    await s.presented();
    const seen = (await drawn.stop()).map((modal) => modal.scroll);
    assert.deepEqual(seen.filter((value) => value !== scroll), [],
      `the settings window moved from ${scroll} while it redrew: ${JSON.stringify(seen)}`);
  });
}
