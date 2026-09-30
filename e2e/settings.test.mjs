// 설정 창의 절(일반, 플러그인, 사이드바), 세트 만들기·편집·삭제, 배치 값 설정을 검사한다(docs/spec/settings.md).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, keepCommonSettings, open } from "./app.mjs";

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

    // 일반: 사이드바 모양이 여기 있고 플러그인 설정은 없다.
    await section(s, "general");
    await control(s, "core.settings-modal.pick", "pick:cardSidebar:inset");
    await control(s, "core.settings-modal.set", "left");
    await control(s, "core.settings-modal.set", "right");
    await control(s, "core.settings-modal.set", "link:left:");
    for (const key of ["sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth"]) {
      await control(s, "core.settings-modal.set", key);
    }
    const pluginKeys = Object.keys((await s.get("core.settings")).values).filter((key) => key.includes("."));
    const general = (await controls(s)).map((c) => c.key ?? "").map((key) => key.startsWith("pick:") ? key.split(":")[1] : key);
    assert.deepEqual(general.filter((key) => pluginKeys.includes(key)), [], "일반 shows plugin settings");

    // 사이드바: 세트 목록과 새 세트만 있다.
    await section(s, "sidebars");
    const sidebars = (await controls(s)).filter((c) => !["core.settings-modal.nav", "core.settings-modal.scope",
      "core.settings-modal.grip", "core.settings-modal.close"].includes(c.name)).map((c) => c.name);
    assert.deepEqual([...new Set(sidebars)].sort(),
      ["core.settings-modal.create", "core.settings-modal.delete", "core.settings-modal.edit"]);

    // 플러그인: 검색 칸과 목록. 검색어가 목록을 거르고, 행이 페이지를 열고, 목록이 돌아온다.
    await section(s, "plugins");
    const list = await s.until("core.settings-modal", (modal) => modal.plugin === null && modal.listed.length > 0,
      "the plugin list did not show");
    assert.deepEqual(list.listed, ["shell", "browser", "files", "terminal"]);
    assert.equal(list.query, "");
    const rows = list.controls.filter((c) => c.name === "core.settings-modal.plugin");
    assert.deepEqual(rows.map((c) => c.key), list.listed.map((id) => `plugin:${id}`));
    assert.ok(rows.every((c) => c.label.includes(" — ")), `a plugin row lacks its description: ${JSON.stringify(rows.map((c) => c.label))}`);
    await press(s, "core.settings-modal.search", "plugin-search", "TERM", "query");
    await s.until("core.settings-modal", (modal) => modal.query === "TERM" && modal.listed.join() === "terminal",
      "the search did not keep only terminal");
    await press(s, "core.settings-modal.search", "plugin-search", "없는플러그인", "query");
    await s.until("core.settings-modal", (modal) => modal.listed.length === 0, "a query without a match still lists plugins");
    await press(s, "core.settings-modal.search", "plugin-search", "", "query");
    await s.until("core.settings-modal", (modal) => modal.listed.length === 4, "an empty query did not list every plugin");

    await press(s, "core.settings-modal.plugin", "plugin:terminal");
    const terminal = await s.until("core.settings-modal", (modal) => modal.plugin === "terminal", "terminal page did not open");
    assert.deepEqual(terminal.listed, [], "the page still shows the plugin list");
    assert.equal(terminal.rows.length, 14, `terminal rows: ${JSON.stringify(terminal.rows)}`);
    assert.deepEqual(terminal.rows.find((row) => row.key === "terminal.cursor.shape"), {
      key: "terminal.cursor.shape", name: "커서 모양",
      description: "block은 칸 전체, underline은 밑줄, beam은 세로 막대로 그린다. 프로그램이 모양을 정하면 그 모양을 쓴다.",
    });
    await control(s, "core.settings-modal.set", "link:right:terminal");
    for (const side of ["left", "right", "top", "bottom"]) {
      assert.equal((await control(s, "core.settings-modal.set", `link:card-${side}:terminal`)).value, "off",
        `the missing card-${side} link did not display off`);
    }
    await press(s, "core.settings-modal.pick", "pick:terminal.cursor.shape:beam");
    await s.until("core.settings", (value) => value.values["terminal.cursor.shape"] === "beam" && !value.saving,
      "the plugin page did not change terminal.cursor.shape");
    await press(s, "core.settings-modal.back", "plugins:list");
    await s.until("core.settings-modal", (modal) => modal.plugin === null && modal.listed.length === 4, "목록 did not return to the list");
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
    await press(s, "core.settings-modal.pick", `layout:${made.id}:tabs`);
    const sectionsOf = async () => (await settingsValue(s, "sets")).find((item) => item.id === made.id).sections;
    const saved = (want, message) => s.until("core.settings", (value) => !value.saving &&
      value.values.sets.find((item) => item.id === made.id)?.sections.join() === want.join(), message);

    // +는 세트에 없는 첫 등록 섹션을 더한다. 세 번 누르면 세 행이다.
    for (let n = 1; n <= 3; n++) {
      await press(s, "core.settings-modal.add", `add:${made.id}`);
      await s.until("core.settings", (value) => !value.saving &&
        value.values.sets.find((item) => item.id === made.id)?.sections.length === n, `+ did not add row ${n}`);
    }
    const three = await sectionsOf();
    assert.equal(new Set(three).size, 3);
    const editor = await s.until("core.settings-modal", (modal) =>
      modal.controls.filter((c) => c.name === "core.settings-modal.row").length === 3, "the editor did not draw three rows");
    // 편집기는 등록된 섹션마다의 컨트롤을 두지 않는다. 행마다 선택 상자 하나와 ▲▼− 가 있고 + 는 하나다.
    assert.equal(editor.controls.filter((c) => c.name === "core.settings-modal.section").length, 0);
    assert.equal(editor.controls.filter((c) => c.name === "core.settings-modal.add").length, 1);
    assert.deepEqual(editor.controls.filter((c) => c.name === "core.settings-modal.row-act").map((c) => c.key), [
      `down:${made.id}:0`, `remove:${made.id}:0`,
      `up:${made.id}:1`, `down:${made.id}:1`, `remove:${made.id}:1`,
      `up:${made.id}:2`, `remove:${made.id}:2`,
    ]);
    const select = editor.controls.find((c) => c.key === `row:${made.id}:0`);
    assert.equal(select.value, three[0]);
    assert.deepEqual(select.groups.map((g) => g.label), ["셸", "브라우저", "파일"]);
    assert.equal(select.groups.flatMap((g) => g.values).length, 9);

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
    await keepCommonSettings(s);
    await s.run("core.settings.set", { patch: { cardSidebar: "inset", sidebarWidth: 150, sidebarMinWidth: 140 }, scope: "common" });
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left?.size === 150),
      "an inset sidebar did not open at sidebarWidth");
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

  test(`${app.name}: a plugin's right sidebar choice takes precedence over the general choice`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const right = async (card, want, message) => {
      await s.run("core.card.focus", { card });
      await s.until("core.sidebars", (bars) => (bars.find((bar) => bar.sidebar === "right")?.set ?? null) === want, message);
    };
    const choose = (plugin, set) => s.run("core.settings.link", { place: "right", plugin, set, scope: "common" });
    // 일반 사용 안 함 + 플러그인 세트 → 보인다. 기본값에서 셸은 set-process 를 고르고 일반 선택은 없다.
    await right("shell", "set-process", "a plugin set did not show while the general choice is off");
    // 일반 세트 + 플러그인 사용 안 함 → 숨는다.
    await choose(null, "set-page");
    await choose("shell", "off");
    await right("shell", null, "plugin 사용 안 함 did not hide the right sidebar");
    // 플러그인 일반 따름 → 일반 세트.
    await choose("shell", "inherit");
    await right("shell", "set-page", "plugin 일반 따름 did not show the general set");
    await right("browser", "set-browser", "the browser set did not take precedence over the general set");
    await assert.rejects(s.run("core.settings.link", { place: "right", plugin: null, set: "inherit", scope: "common" }), /inherit/);
  });

  test(`${app.name}: a fresh configuration starts with inset sidebars and lists 카드 안 first`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    assert.equal(await settingsValue(s, "cardSidebar"), "inset");
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left),
      "no card holds an inset sidebar in a fresh configuration");
    assert.equal(grid.cards.some((card) => card.id.startsWith("rail-")), false, "a rail column stands in a fresh configuration");
    await s.run("core.settings.open");
    s.cleanup(() => s.run("core.settings.close"));
    await section(s, "general");
    await control(s, "core.settings-modal.pick", "pick:cardSidebar:inset");
    const keys = (await controls(s)).filter((c) => c.key?.startsWith("pick:cardSidebar:")).map((c) => c.key);
    assert.deepEqual(keys, ["pick:cardSidebar:inset", "pick:cardSidebar:flow", "pick:cardSidebar:pin", "pick:cardSidebar:off"]);
  });

  test(`${app.name}: performance tracing records enabled card focus and stops while disabled`, { timeout: 30000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    // 호스트는 설정 디렉터리의 심볼릭 링크를 해소한 경로를 사용한다.
    const config = realpathSync(app.configDir);
    const file = join(config, "logs", "performance.ndjson");
    const flag = join(config, "performance");
    const services = join(config, "services");
    const serviceFlags = () => existsSync(services) ? readdirSync(services, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => join(services, entry.name, "performance")) : [];
    const read = () => existsSync(file) ? readFileSync(file, "utf8") : "";
    const change = (enabled) => s.run("core.settings.set", {
      scope: "common", patch: { "diagnostics.performance": enabled },
    });
    await change(false);
    assert.ok(!existsSync(flag), "disabled host retained its runtime switch");
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.length).id;
    const before = read();
    await s.run("core.card.focus", { card });
    assert.equal(read(), before, "disabled focus changed the trace output");
    await change(true);
    assert.equal(readFileSync(flag, "utf8"), `${file}\n`, "enabled host switch does not contain its trace target");
    for (const serviceFlag of serviceFlags()) {
      assert.equal(readFileSync(serviceFlag, "utf8"), `${file}\n`, `enabled service flag does not contain its trace target: ${serviceFlag}`);
    }
    await s.run("core.card.focus", { card });
    await change(false);
    assert.ok(!existsSync(flag), "host disable retained its runtime switch");
    for (const serviceFlag of serviceFlags()) {
      assert.ok(!existsSync(serviceFlag), `host disable retained a service flag: ${serviceFlag}`);
    }
    assert.ok(existsSync(file), "enabled tracing did not create its declared output");
    const after = read();
    const events = after.slice(before.length).trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(events.some((line) => line.layer === "page" && line.event === "action"
      && line.kind === "card.focus" && line.card === card), "enabled focus action was not recorded");
    assert.ok(events.some((line) => line.layer === "page" && line.event === "command"
      && line.name === "core.card.focus" && line.ok === true), "enabled focus command was not recorded");
    await s.run("core.card.focus", { card });
    assert.equal(read(), after, "focus after disable changed the trace output");
  });

  test(`${app.name}: a new inset sidebar opens at 190 points`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await keepCommonSettings(s);
    const grid = await s.until("core.grid", (value) => value.cards.some((card) => card.sidebars?.left),
      "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebars?.left);
    assert.equal(card.sidebars.left.size, 190);
    assert.equal(card.sidebars.left.collapsed, false);
  });
}
