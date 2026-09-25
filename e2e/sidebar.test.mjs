// 사이드바 검사: inset 사이드바의 자리, 접기, 폭 변경과, 세트의 섹션을 list 와 tabs 레이아웃으로 마운트하는지 검사한다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

/** 손잡이는 사이드바 테두리 위에 겹치므로 표면은 사이드바 바로 뒤에서 시작한다. */
const GRIP = 0;
/** 접은 사이드바의 폭(pt). */
const FOLDED = 28;

for (const app of Object.values(APPS)) {
  test(`${app.name}: an inset sidebar stands inside its card and folds or resizes without changing the card`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "rail" }));
    const railed = (grid) => grid.cards.filter((card) => card.id.startsWith("rail"));
    await s.run("core.settings.change", { key: "rail", value: "inset", scope: "common" });
    const grid = await s.until("core.grid", (value) => railed(value).length === 0 && value.cards.some((card) => card.sidebar),
      "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebar);
    assert.deepEqual(card.sidebar, { width: 120, collapsed: false });
    const surfaceOf = async () => (await s.get("core.surfaces")).find((item) => item.surface === card.active);
    // 표면 위치는 판의 원점과 카드 테두리(1pt)를 더한 문서 좌표다.
    const origin = grid.plane.x + card.x + 1;
    const surfaceAt = async (inside) => s.until("core.surfaces", (surfaces) => {
      const surface = surfaces.find((item) => item.surface === card.active);
      return surface && Math.abs(surface.applied.x - (origin + inside)) <= 1;
    }, `the surface did not start ${inside} pt into the card`);
    await surfaceAt(120 + GRIP);
    const before = await surfaceOf();

    await s.run("core.card.sidebar.toggle", { card: card.id });
    const folded = await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.collapsed === true,
      "the sidebar did not fold");
    const same = folded.cards.find((item) => item.id === card.id);
    assert.deepEqual([same.x, same.w, same.h], [card.x, card.w, card.h], "folding changed the card");
    await surfaceAt(FOLDED + GRIP);

    await s.run("core.card.sidebar.toggle", { card: card.id });
    await s.run("core.card.sidebar.size", { card: card.id, width: 260 });
    const resized = await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.width === 260,
      "the sidebar did not take the new width");
    const kept = resized.cards.find((item) => item.id === card.id);
    assert.deepEqual([kept.x, kept.w, kept.h], [card.x, card.w, card.h], "resizing the sidebar changed the card");
    await surfaceAt(260 + GRIP);
    await assert.rejects(s.run("core.card.sidebar.size", { card: card.id, width: 60 }), /120 to 480/);
    assert.ok(before, "the surface was measured");
    // 손잡이를 두 번 누르면 가장 좁은 폭(120pt)이 된다.
    await s.act("core.card.sidebar.grip", "dispatch", { index: 0, event: { type: "dblclick" } });
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.width === 120,
      "a double click on the grip did not set the minimum width");
    // 접기 단추를 네이티브 클릭으로 누르면 접힌다.
    const fold = await s.rect("core.card.sidebar.fold", 0);
    await s.click(fold.x + fold.width / 2, fold.y + fold.height / 2);
    await s.until("core.grid", (value) => value.cards.find((item) => item.id === card.id)?.sidebar?.collapsed === true,
      "a click on the fold button did not fold the sidebar");
  });
}

/** 문서 순서의 사이드바 목록에서 layout 을 쓰는 사이드바의 섹션 앞에 놓인 같은 종류 요소의 수. */
const indexOf = (sidebars, layout, sidebar, section) => {
  let index = 0;
  for (const item of sidebars.filter((value) => value.layout === layout)) {
    if (item.sidebar === sidebar) return index + item.sections.findIndex((value) => value.id === section);
    index += item.sections.length;
  }
  throw new Error(`no ${layout} sidebar ${sidebar}`);
};

/** 요소의 가운데를 네이티브 입력으로 누른다. */
const press = async (s, name, index) => {
  const rect = await s.rect(name, index);
  assert.ok(rect.width > 0 && rect.height > 0, `${name} ${index} has no area`);
  await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: a combined set mounts every section in list layout and switches sections in tabs layout`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    s.cleanup(() => s.run("core.settings.reset", { key: "rail" }));
    const rail = "rail-shell";
    const of = (sidebars, id) => sidebars.find((item) => item.sidebar === id);
    const mounted = (item, ids) => item && ids.every((id) => item.sections.find((value) => value.id === id)?.mounted);

    // list: 셸 레일의 세트는 두 섹션을 모두 마운트한다.
    let sidebars = await s.until("core.sidebars", (value) => mounted(of(value, rail), ["shell.history", "shell.cwd"]),
      "the shell rail did not mount both sections");
    const listed = of(sidebars, rail);
    assert.equal(listed.layout, "list");
    assert.deepEqual(listed.sections.map((item) => [item.id, item.folded, item.error]),
      [["shell.history", false, null], ["shell.cwd", false, null]]);
    const shellCard = (await s.get("core.grid")).cards.find((card) => card.id === "shell");
    assert.deepEqual([listed.card, listed.surface], ["shell", shellCard.active], "the sections received the focused card and tab");
    // 네이티브 클릭으로 머리를 누르면 그 섹션이 접힌다.
    await press(s, "core.sidebar.section.header", indexOf(sidebars, "list", rail, "shell.cwd"));
    sidebars = await s.until("core.sidebars", (value) => of(value, rail)?.sections[1].folded === true,
      "a click on the header did not fold the section");
    assert.equal(of(sidebars, rail).sections[0].folded, false);

    // tabs: 같은 세트를 tabs 로 바꾸면 고른 섹션 하나만 마운트한다.
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-shell" ? { ...set, layout: "tabs" } : set) },
      scope: "common" });
    sidebars = await s.until("core.sidebars", (value) => of(value, rail)?.layout === "tabs" && mounted(of(value, rail), ["shell.history"]),
      "the tabs layout did not mount the first section");
    assert.equal(of(sidebars, rail).tab, "shell.history");
    assert.equal(of(sidebars, rail).sections[1].mounted, false, "a section of an unselected tab is mounted");
    await press(s, "core.sidebar.section.tab", indexOf(sidebars, "tabs", rail, "shell.cwd"));
    sidebars = await s.until("core.sidebars", (value) => of(value, rail)?.tab === "shell.cwd" && mounted(of(value, rail), ["shell.cwd"]),
      "a click on the tab did not show its section");
    assert.equal(of(sidebars, rail).sections[0].mounted, false, "the previous tab's section stayed mounted");

    // 선택은 사이드바마다 유지된다. inset 사이드바는 자기 선택으로 시작하고, 레일로 돌아오면 레일의 선택이 남아 있다.
    await s.run("core.settings.change", { key: "rail", value: "inset", scope: "common" });
    sidebars = await s.until("core.sidebars", (value) => !of(value, rail) && mounted(of(value, "shell"), ["shell.history"]),
      "the inset sidebar did not mount its first tab");
    assert.equal(of(sidebars, "shell").tab, "shell.history");
    await s.run("core.sidebar.section.select", { sidebar: "shell", section: "shell.history" });
    await s.run("core.settings.change", { key: "rail", value: "flow", scope: "common" });
    sidebars = await s.until("core.sidebars", (value) => of(value, rail)?.tab === "shell.cwd" && mounted(of(value, rail), ["shell.cwd"]),
      "the rail did not keep its selection");
    await assert.rejects(s.run("core.sidebar.section.fold", { sidebar: rail, section: "shell.cwd" }), /does not use the list layout/);
  });
}

/** 문서 순서의 core.sidebar.section.control 중 sidebar 의 section 이 그린 at 번째 조작 요소의 index. */
const controlIndex = (sidebars, sidebar, section, at) => {
  let index = 0;
  for (const item of sidebars) {
    for (const value of item.sections) {
      if (item.sidebar === sidebar && value.id === section) {
        assert.ok(at < value.controls, `${sidebar} ${section} has ${value.controls} controls`);
        return index + at;
      }
      index += value.controls;
    }
  }
  throw new Error(`no section ${section} in ${sidebar}`);
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: the shell sections show the shell's directory, written lines, and pending runs`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const rail = "rail-shell";
    const sections = ["shell.history", "shell.cwd", "shell.jobs"];
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-shell" ? { ...set, sections } : set) },
      scope: "common" });
    const of = (sidebars) => sidebars.find((item) => item.sidebar === rail);
    const text = (sidebars, id) => of(sidebars)?.sections.find((item) => item.id === id)?.text;
    let sidebars = await s.until("core.sidebars", (value) => sections.every((id) => text(value, id) !== undefined
      && of(value).sections.find((item) => item.id === id).mounted), "the shell rail did not mount the three sections");
    const surface = of(sidebars).surface;
    assert.ok(surface, "the rail sections received the shell tab");

    // cwd: 섹션은 shell.cwd 가 보고한 디렉터리를 보인다.
    await s.run("shell.write", { data: "cd /\n" }, surface);
    await s.until("shell.cwd", (cwd) => cwd === "/", "the shell did not report /", { surface });
    sidebars = await s.until("core.sidebars", (value) => text(value, "shell.cwd") === "/",
      "the cwd section did not show the reported directory");

    // 실행 기록: 쓴 줄이 항목이 되고, 항목을 네이티브 클릭으로 누르면 같은 줄을 다시 쓴다.
    const history = await s.get("shell.history", surface);
    assert.equal(history.at(-1), "cd /");
    sidebars = await s.until("core.sidebars", (value) => text(value, "shell.history") === history.join(""),
      "the run history section did not show shell.history");
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, rail, "shell.history", history.length - 1));
    await s.until("shell.history", (value) => value.length === history.length + 1 && value.at(-1) === "cd /",
      "a click on a history entry did not write the line again", { surface });

    // 작업: 끝나지 않은 shell.run 이 보이고, 중단 단추가 그 실행을 끝낸다.
    const running = s.run("shell.run", { command: "sleep 30" }, surface).catch((error) => error);
    await s.until("shell.jobs", (value) => value.length === 1 && value[0].command === "sleep 30",
      "shell.jobs did not report the run", { surface });
    sidebars = await s.until("core.sidebars", (value) => text(value, "shell.jobs") === "sleep 30중단",
      "the jobs section did not show the pending run");
    const entries = (await s.get("shell.history", surface)).length;
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, rail, "shell.jobs", 0));
    await s.until("shell.jobs", (value) => value.length === 0, "the interrupt control did not end the run", { surface });
    assert.equal((await s.get("shell.history", surface)).length, entries, "the press wrote a history line instead");
    const ended = await running;
    assert.notEqual(ended?.exit, 0, `the interrupted run did not report a failure: ${JSON.stringify(ended)}`);
    await s.until("core.sidebars", (value) => text(value, "shell.jobs") === "실행 중인 작업 없음",
      "the jobs section did not show that no run is pending");
  });
}

/** 경로 이름을 제목으로 갖는 문서를 주는 루프백 서버. 검사가 끝나면 닫는다. */
async function serveTitles(t) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>${name}</title><body>${name}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser sections list the session history and the card's browser tabs`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const base = await serveTitles(t);
    const sidebar = "right";
    const sections = ["browser.tabs", "browser.history"];
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-browser" ? { ...set, sections, layout: "list" } : set) },
      scope: "common" });
    await s.run("core.card.focus", { card: "browser" });
    const of = (sidebars) => sidebars.find((item) => item.sidebar === sidebar);
    const text = (sidebars, id) => of(sidebars)?.sections.find((item) => item.id === id)?.text;
    let sidebars = await s.until("core.sidebars", (value) => of(value)?.set === "set-browser"
      && sections.every((id) => of(value).sections.find((item) => item.id === id)?.mounted),
    "the right sidebar did not mount the browser sections");
    const surface = of(sidebars).surface;
    assert.ok(surface, "the browser sections received the browser tab");

    // 히스토리: 연 두 문서가 항목이 되고, 첫 항목을 네이티브 클릭으로 누르면 그 문서를 연다.
    for (const name of ["one", "two"]) {
      await s.run("browser.navigate", { url: `${base}/${name}` }, surface);
      await s.until("browser.location", (at) => at.url === `${base}/${name}` && !at.loading && at.title === name,
        `the browser did not load ${name}`, { surface });
    }
    sidebars = await s.until("core.sidebars", (value) => text(value, "browser.history") === "onetwo",
      "the history section did not list the two documents");
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, sidebar, "browser.history", 0));
    await s.until("browser.location", (at) => at.url === `${base}/one` && !at.loading,
      "a click on the first history entry did not load it", { surface });

    // 탭: 카드의 브라우저 탭이 제목과 함께 보이고, 첫 탭을 누르면 그 탭이 활성 탭이 된다.
    const { tab } = await s.run("core.card.add-tab", { card: "browser", plugin: "browser" });
    await s.until("core.grid", (grid) => grid.cards.find((card) => card.id === "browser")?.active === tab,
      "the added browser tab did not become active");
    const tabs = (await s.get("core.grid")).cards.find((card) => card.id === "browser").tabs;
    assert.deepEqual(tabs.map((item) => item.id), [surface, tab]);
    const shown = tabs.map((item) => item.label ?? item.title).join("");
    sidebars = await s.until("core.sidebars", (value) => text(value, "browser.tabs") === shown,
      `the tabs section did not list the card's browser tabs with their titles: ${shown}`);
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, sidebar, "browser.tabs", 0));
    await s.until("core.grid", (grid) => grid.cards.find((card) => card.id === "browser")?.active === surface,
      "a click on the first tab did not select it");
  });
}
