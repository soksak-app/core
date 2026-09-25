// 설정 창의 절(일반, 플러그인, 사이드바), 세트 만들기·편집·삭제, 배치 값 설정을 검사한다(docs/spec/settings.md).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/** 설정 창의 현재 컨트롤. */
const controls = async (s) => (await s.get("core.settings-modal")).controls;

/** 이름과 키로 컨트롤을 찾을 때까지 기다린다. */
async function control(s, name, key) {
  const modal = await s.until("core.settings-modal",
    (value) => value.controls.some((c) => c.name === name && c.key === key), `settings control ${name} ${key} did not appear`);
  return modal.controls.find((c) => c.name === name && c.key === key);
}

/** 컨트롤이 가리키는 명령을 실행한다. value 가 있으면 값 입력으로 보낸다. */
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
  test(`${app.name}: settings show general, plugin, and sidebar sections without compositing`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    const opened = await s.until("core.settings-modal", (modal) => modal.open, "settings did not open");
    const navs = opened.controls.filter((c) => c.name === "core.settings-modal.nav").map((c) => c.key);
    assert.deepEqual(navs, ["nav:general", "nav:plugins", "nav:sidebars"]);

    await section(s, "general");
    const settings = await s.get("core.settings");
    const pluginKeys = Object.keys(settings.values).filter((key) => key.includes("."));
    assert.ok(pluginKeys.length > 0, "the environment declares no plugin setting");
    const forbidden = new Set([...pluginKeys, "rail", "left", "right", "sets", "links"]);
    const general = (await controls(s)).map((c) => c.key ?? "").map((key) => key.startsWith("pick:") ? key.split(":")[1] : key);
    const leaked = general.filter((key) => forbidden.has(key) || key.startsWith("link:"));
    assert.deepEqual(leaked, [], "일반 shows plugin or sidebar settings");

    await section(s, "plugins");
    const listed = (await controls(s)).filter((c) => c.name === "core.settings-modal.plugin").map((c) => c.key);
    assert.deepEqual(listed, ["plugin:shell", "plugin:browser", "plugin:files", "plugin:terminal"]);
    assert.equal((await s.get("core.settings-modal")).plugin, "shell", "the first plugin is not selected");
    await control(s, "core.settings-modal.set", "link:rail:shell");
    await control(s, "core.settings-modal.set", "link:right:shell");

    await press(s, "core.settings-modal.plugin", "plugin:terminal");
    const terminal = await s.until("core.settings-modal", (modal) => modal.plugin === "terminal", "terminal was not selected");
    const keys = new Set(terminal.controls.map((c) => c.key ?? "")
      .map((key) => key.startsWith("pick:") ? key.split(":")[1] : key)
      .filter((key) => key.startsWith("terminal.")));
    assert.equal(keys.size, 13, `terminal shows ${keys.size} settings: ${[...keys]}`);
    // 행 이름은 manifest 의 label 이고, 설명이 있는 설정은 그 아래에 설명을 보인다.
    assert.equal(terminal.rows.length, 13, `terminal rows: ${JSON.stringify(terminal.rows)}`);
    assert.deepEqual(terminal.rows.find((row) => row.key === "terminal.cursor.shape"), {
      key: "terminal.cursor.shape", name: "커서 모양",
      description: "block은 칸 전체, underline은 밑줄, beam은 세로 막대로 그린다. 프로그램이 모양을 정하면 그 모양을 쓴다.",
    });
    assert.equal(terminal.rows.find((row) => row.key === "terminal.cursor.interval").description, null);
    assert.ok(terminal.rows.every((row) => row.name && !row.name.includes(".")), "a plugin setting row shows its key");
    await press(s, "core.settings-modal.pick", "pick:terminal.cursor.shape:beam");
    await s.until("core.settings", (value) => value.values["terminal.cursor.shape"] === "beam" && !value.saving,
      "the plugin page did not change terminal.cursor.shape");

    await press(s, "core.settings-modal.plugin", "plugin:files");
    const files = await s.until("core.settings-modal", (modal) => modal.plugin === "files", "files was not selected");
    assert.ok(!files.controls.some((c) => c.key?.startsWith("link:rail:")), "a plugin without a surface shows a rail link");

    await section(s, "sidebars");
    await control(s, "core.settings-modal.pick", "pick:rail:inset");
    await control(s, "core.settings-modal.set", "left");
    await control(s, "core.settings-modal.set", "link:left:");
    for (const key of ["sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth", "sidebarFoldedWidth", "railWidth"]) {
      await control(s, "core.settings-modal.set", key);
    }
  });

  test(`${app.name}: settings create, edit, and delete a sidebar set`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
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
    await press(s, "core.settings-modal.pick", `layout:${made.id}:tabs`);
    await press(s, "core.settings-modal.section", `section:${made.id}:files.tree`);
    await press(s, "core.settings-modal.section", `section:${made.id}:shell.jobs`);
    const edited = await s.until("core.settings", (value) => {
      const found = value.values.sets.find((item) => item.id === made.id);
      return !value.saving && found?.title === "검사 세트" && found.layout === "tabs" && found.sections.join() === "files.tree,shell.jobs";
    }, "the editor did not change the title, layout, and sections");
    assert.ok(edited);
    await press(s, "core.settings-modal.section", `section:${made.id}:files.tree`);
    await s.until("core.settings", (value) => !value.saving &&
      value.values.sets.find((item) => item.id === made.id)?.sections.join() === "shell.jobs", "a section was not removed");

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
    await s.run("core.settings.set", { patch: { rail: "inset", sidebarWidth: 150, sidebarMinWidth: 140 }, scope: "common" });
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebar?.width === 150),
      "an inset sidebar did not open at sidebarWidth");
    const card = grid.cards.find((item) => item.sidebar);
    await assert.rejects(s.run("core.card.sidebar.size", { card: card.id, width: 130 }), /140 to 480/);
    await assert.rejects(s.run("core.settings.set", { patch: { sidebarMinWidth: 200 }, scope: "common" }),
      /sidebarMinWidth .*sidebarWidth .*sidebarMaxWidth/);
    await s.act("core.card.sidebar.grip", "dispatch", { index: 0, event: { type: "dblclick" } });
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.width === 140,
      "a double click did not set sidebarMinWidth");
  });

  test(`${app.name}: an invalid stored set or link is rejected when it is changed and when it is loaded`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const sets = await settingsValue(s, "sets");
    const broken = sets.map((item, index) => (index === 0 ? { ...item, sections: [...item.sections, "gone.section"] } : item));
    await assert.rejects(s.run("core.settings.set", { patch: { sets: broken }, scope: "common" }),
      /names unknown section gone.section/);
    await assert.rejects(s.run("core.settings.set", { patch: { links: [{ place: "left", plugin: null, set: "set-none" }] }, scope: "common" }),
      /known set/);
    assert.deepEqual(await settingsValue(s, "sets"), sets, "a rejected change altered the sets");

    // 프로젝트 설정 파일에 등록되지 않은 섹션을 담은 세트가 있으면 그 프로젝트를 불러올 때 오류가 보인다.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "soksak-sets-")));
    s.cleanup(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".soksak"), { recursive: true });
    writeFileSync(join(root, ".soksak/settings.json"), JSON.stringify({ sets: broken }));
    await s.run("core.settings.set", { patch: { projectOpening: "tabs" }, scope: "common" });
    const opened = s.run("core.project.open", { root, color: "#7fe3b0" }).catch((error) => error);
    s.cleanup(async () => {
      for (const item of await s.get("core.projects")) {
        if (item.root === root) await s.run("core.project.close", { id: item.id });
      }
    });
    await s.until("core.page.error", (text) => /settings: set .* names unknown section gone\.section/.test(text ?? ""),
      "loading a project with an invalid stored set showed no error");
    await opened;
  });
}
