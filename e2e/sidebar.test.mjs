// 사이드바 검사: inset 사이드바의 자리, 접기, 폭 변경과, 세트의 섹션을 list 와 tabs 레이아웃으로 마운트하는지 검사한다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { rmSync } from "node:fs";
import { frames, pixel, readFrame } from "./frame.mjs";

/** 손잡이는 사이드바 테두리 위에 겹치므로 표면은 사이드바 바로 뒤에서 시작한다. */
const GRIP = 0;
/** 접은 사이드바에 남는 경계선의 폭(pt). */
const DIVIDER = 6;

for (const app of Object.values(APPS)) {
  test(`${app.name}: an inset sidebar stands inside its card and folds or resizes without changing the card`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    const railed = (grid) => grid.cards.filter((card) => card.id.startsWith("rail"));
    await s.run("core.settings.change", { key: "cardSidebar", value: "inset", scope: "common" });
    const grid = await s.until("core.grid", (value) => railed(value).length === 0 && value.cards.some((card) => card.sidebar),
      "no card holds an inset sidebar");
    const card = grid.cards.find((item) => item.sidebar);
    assert.deepEqual(card.sidebar, { width: 190, collapsed: false });
    const sidebarOf = (value) => value.cards.find((item) => item.id === card.id)?.sidebar;
    const surfaceOf = async () => (await s.get("core.surfaces")).find((item) => item.surface === card.active);
    // 표면 위치는 판의 원점과 카드 테두리(1pt)를 더한 문서 좌표다.
    const origin = grid.plane.x + card.x + 1;
    const surfaceAt = async (inside) => s.until("core.surfaces", (surfaces) => {
      const surface = surfaces.find((item) => item.surface === card.active);
      return surface && Math.abs(surface.applied.x - (origin + inside)) <= 1;
    }, `the surface did not start ${inside} pt into the card`);
    await surfaceAt(190 + GRIP);
    const before = await surfaceOf();

    await s.run("core.card.sidebar.toggle", { card: card.id });
    const folded = await s.until("core.grid", (value) => sidebarOf(value)?.collapsed === true, "the sidebar did not fold");
    const same = folded.cards.find((item) => item.id === card.id);
    assert.deepEqual([same.x, same.w, same.h], [card.x, card.w, card.h], "folding changed the card");
    await surfaceAt(DIVIDER);

    await s.run("core.card.sidebar.toggle", { card: card.id });
    await s.run("core.card.sidebar.size", { card: card.id, width: 260 });
    const resized = await s.until("core.grid", (value) => sidebarOf(value)?.width === 260, "the sidebar did not take the new width");
    const kept = resized.cards.find((item) => item.id === card.id);
    assert.deepEqual([kept.x, kept.w, kept.h], [card.x, card.w, card.h], "resizing the sidebar changed the card");
    await surfaceAt(260 + GRIP);
    await assert.rejects(s.run("core.card.sidebar.size", { card: card.id, width: 60 }), /120 to 480/);
    assert.ok(before, "the surface was measured");
    await s.run("core.card.sidebar.size", { card: card.id, width: 190 });

    // 경계선의 사이드바 쪽 절반을 네이티브로 끌면 폭이 바뀐다. 끌기는 누름이 아니므로 접히지 않는다.
    let divider = await s.rect("core.card.sidebar.grip", 0);
    const y = divider.y + divider.height / 2;
    const x = divider.x + divider.width / 4;
    await s.pointer(x, y, "down");
    await s.pointer(x + 30, y, "drag");
    await s.pointer(x + 60, y, "drag");
    await s.pointer(x + 60, y, "up");
    const dragged = await s.until("core.grid", (value) => Math.abs(sidebarOf(value)?.width - 250) <= 2, "a drag on the divider did not resize");
    assert.equal(sidebarOf(dragged).collapsed, false, "a drag on the divider folded the sidebar");

    // 네이티브 누름은 곧바로 접는다. 다음 표시에 이미 접혀 있어야 한다. 접힌 뒤에는 경계선만 남고, 다시 누르면 펴진다.
    // core.grid 는 문서가 새 폭을 그리기 전에 바뀐다. 끌기의 배치가 표시된 뒤 경계선의 자리를 읽는다.
    await s.presented();
    divider = await s.rect("core.card.sidebar.grip", 0);
    await s.click(divider.x + divider.width / 4, y);
    await s.presented();
    assert.equal(sidebarOf(await s.get("core.grid")).collapsed, true, "a click on the divider did not fold the sidebar by the next presentation");
    await surfaceAt(DIVIDER);
    divider = await s.rect("core.card.sidebar.grip", 0);
    assert.ok(Math.abs(divider.width - DIVIDER) <= 0.5, `the folded divider is ${divider.width} pt wide`);
    await s.click(divider.x + divider.width / 2, y);
    await s.presented();
    assert.equal(sidebarOf(await s.get("core.grid")).collapsed, false, "a click on the folded divider did not unfold the sidebar by the next presentation");
    await surfaceAt(sidebarOf(dragged).width + GRIP);
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
    // 기본 사이드바 위치는 inset 이다. 레일 사이드바를 보려면 flow 로 둔다.
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    await s.run("core.settings.change", { key: "cardSidebar", value: "flow", scope: "common" });
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
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
    await s.run("core.settings.change", { key: "cardSidebar", value: "inset", scope: "common" });
    sidebars = await s.until("core.sidebars", (value) => !of(value, rail) && mounted(of(value, "shell"), ["shell.history"]),
      "the inset sidebar did not mount its first tab");
    assert.equal(of(sidebars, "shell").tab, "shell.history");
    await s.run("core.sidebar.section.select", { sidebar: "shell", section: "shell.history" });
    await s.run("core.settings.change", { key: "cardSidebar", value: "flow", scope: "common" });
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
    // 기본 사이드바 위치는 inset 이다. 레일 사이드바를 보려면 flow 로 둔다.
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    await s.run("core.settings.change", { key: "cardSidebar", value: "flow", scope: "common" });
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
    // inspect 는 요소 하나와 이미지 요청 하나를 가진다.
    if (name === "untitled") { response.end("<!doctype html><body>untitled"); return; }
    response.end(name === "inspect"
      ? `<!doctype html><title>inspect</title><body><div id="box" class="a b"><img src="/pixel"></div>`
      : `<!doctype html><title>${name}</title><body>${name}`);
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

/** sRGB 색의 상대 휘도. */
const luminance = ([r, g, b]) => {
  const c = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
/** 두 색의 대비. 밝은 쪽을 위에 둔다. */
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** 디자인의 머리 선(#2a2d3a)과 머리 배경(#20232d)의 대비. */
const DESIGN_RULE_CONTRAST = contrast([0x2a, 0x2d, 0x3a], [0x20, 0x23, 0x2d]);

/** 창을 녹화해 섹션 머리의 아래 선 픽셀과 머리 가운데 배경 픽셀의 대비를 잰다. */
async function headerRuleContrast(s, rect) {
  const { displayed } = await s.presented();
  await s.request("diagnostics.capture.start", {});
  const result = await s.request("diagnostics.capture.stop", { after: displayed });
  try {
    const files = frames(result.frames);
    assert.ok(files.length > 0, "the header capture produced no frames");
    const frame = readFrame(files.at(-1));
    // 이름 글자를 피해 머리 오른쪽 끝 가까이에서 잰다.
    const x = Math.round((rect.x + rect.width - 6) * frame.scale);
    const rule = pixel(frame, x, Math.ceil((rect.y + rect.height) * frame.scale) - 1);
    const back = pixel(frame, x, Math.round((rect.y + rect.height / 2) * frame.scale));
    return contrast(rule, back);
  } finally {
    rmSync(result.frames, { recursive: true, force: true });
  }
}

/** 두 길이가 반 포인트 안에서 같은지. */
const near = (a, b) => Math.abs(a - b) <= 0.5;

/** 이름의 모든 요소 사각형. 없는 index 에서 멈춘다. */
const rects = async (s, name) => {
  const out = [];
  for (;;) {
    try {
      out.push(await s.rect(name, out.length));
    } catch {
      return out;
    }
  }
};

for (const app of Object.values(APPS)) {
  test(`${app.name}: a sidebar starts with its sections and lines up its header and status rules with the neighbouring cards`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // 기본 사이드바 위치는 inset 이다. 레일 사이드바를 보려면 flow 로 둔다.
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    await s.run("core.settings.change", { key: "cardSidebar", value: "flow", scope: "common" });
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    const locate = async (sidebar) => {
      const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === sidebar)?.sections.every((item) => item.mounted),
        `sidebar ${sidebar} did not mount its sections`);
      const at = sidebars.findIndex((item) => item.sidebar === sidebar);
      const box = await s.rect("core.sidebar", at);
      const first = await s.rect("core.sidebar.section", sidebars.slice(0, at).reduce((sum, item) => sum + item.sections.length, 0));
      assert.ok(near(first.y, box.y), `${sidebar}: the first section starts ${first.y - box.y} pt below the sidebar top`);
      const header = await s.rect("core.sidebar.section.header", sidebars.slice(0, at).filter((item) => item.layout === "list")
        .reduce((sum, item) => sum + item.sections.length, 0));
      const inside = (rect) => rect.x + rect.width / 2 > box.x && rect.x + rect.width / 2 < box.x + box.width;
      const line = (await rects(s, "core.sidebar.status")).find(inside);
      assert.ok(line, `${sidebar}: no status line`);
      assert.ok(line.y >= box.y + box.height - 0.5, `${sidebar}: the status line is not below the sections`);
      assert.ok(box.height > 100, `${sidebar}: the sections have only ${box.height} pt`);
      return { box, header, line };
    };
    // 이웃 카드: 판 맨 위 카드의 머리와 판 맨 아래 카드의 발.
    const cardHeaders = await rects(s, "core.card.header");
    const top = cardHeaders.reduce((a, b) => (b.y < a.y ? b : a));
    const cardFooters = await rects(s, "core.card.status");
    const bottom = cardFooters.reduce((a, b) => (b.y + b.height > a.y + a.height ? b : a));
    for (const sidebar of ["left", "right", "rail-shell"]) {
      const { header, line } = await locate(sidebar);
      assert.ok(near(header.y + header.height, top.y + top.height),
        `${sidebar}: the first header rule is at ${header.y + header.height}, the card header rule at ${top.y + top.height}`);
      assert.ok(near(line.y, bottom.y), `${sidebar}: the status line rule is at ${line.y}, the card footer rule at ${bottom.y}`);
    }
    // 머리의 아래 선은 머리 배경과 디자인만큼 구별된다(디자인: #20232d 머리 위 #2a2d3a 선).
    const ratio = await headerRuleContrast(s, (await locate("left")).header);
    assert.ok(ratio >= DESIGN_RULE_CONTRAST, `the header rule contrast ${ratio.toFixed(3)} is below the design's ${DESIGN_RULE_CONTRAST.toFixed(3)}`);
    // inset 사이드바는 카드 머리 줄을 함께 쓰므로 첫 섹션이 그 머리 바로 아래에서 시작한다.
    await s.run("core.settings.change", { key: "cardSidebar", value: "inset", scope: "common" });
    await s.until("core.sidebars", (value) => value.some((item) => item.sidebar === "shell"), "the inset sidebar was not drawn");
    const shellHeader = (await rects(s, "core.card.header")).reduce((a, b) => (b.y < a.y ? b : a));
    const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === "shell")?.sections.every((item) => item.mounted),
      "the inset sidebar did not mount its sections");
    const box = await s.rect("core.sidebar", sidebars.findIndex((item) => item.sidebar === "shell"));
    assert.ok(near(box.y, shellHeader.y + shellHeader.height), `shell: the inset sections start at ${box.y}, the card header ends at ${shellHeader.y + shellHeader.height}`);
    // 카드 안 사이드바는 상태 줄이 없고 섹션이 카드 발의 위 선까지 채운다.
    const inside = (rect) => rect.x + rect.width / 2 > box.x && rect.x + rect.width / 2 < box.x + box.width;
    assert.deepEqual((await rects(s, "core.sidebar.status")).filter(inside), [], "the inset sidebar has a status line");
    const footer = (await rects(s, "core.card.status")).find((rect) => rect.x <= box.x + 0.5 && rect.x + rect.width >= box.x + box.width - 0.5
      && rect.y >= box.y);
    assert.ok(footer && near(box.y + box.height, footer.y), `shell: the inset sections end at ${box.y + box.height}, the card footer starts at ${footer?.y}`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the browser DOM and network sections list the document's elements and requests`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const base = await serveTitles(t);
    const sidebar = "right";
    const sections = ["browser.dom", "browser.network"];
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-browser" ? { ...set, sections, layout: "list" } : set) },
      scope: "common" });
    await s.run("core.card.focus", { card: "browser" });
    const of = (sidebars) => sidebars.find((item) => item.sidebar === sidebar);
    const text = (sidebars, id) => of(sidebars)?.sections.find((item) => item.id === id)?.text ?? "";
    const sidebars = await s.until("core.sidebars", (value) => of(value)?.set === "set-browser"
      && sections.every((id) => of(value).sections.find((item) => item.id === id)?.mounted),
    "the right sidebar did not mount the DOM and network sections");
    const surface = of(sidebars).surface;
    await s.run("browser.navigate", { url: `${base}/inspect` }, surface);
    const elements = await s.until("browser.elements", (value) => value.nodes.some((node) => node.id === "box"),
      "browser.elements did not report the document's elements", { surface });
    assert.deepEqual(elements.nodes.map((node) => `${node.depth}:${node.tag}`), ["0:html", "1:head", "2:title", "1:body", "2:div", "3:img"]);
    const requests = await s.until("browser.requests", (value) => value.entries.some((entry) => entry.url === `${base}/pixel`),
      "browser.requests did not report the image request", { surface });
    assert.deepEqual(requests.entries.map((entry) => [entry.type, entry.url]), [["navigation", `${base}/inspect`], ["img", `${base}/pixel`]]);
    await s.until("core.sidebars", (value) => text(value, "browser.dom") === "htmlheadtitlebodydiv#box.a.bimg"
      && text(value, "browser.network").startsWith(`navigation ${base}/inspect `) && text(value, "browser.network").includes(`img ${base}/pixel `),
    "the DOM and network sections did not show the elements and requests");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a browser tab and the tabs section show the document title or the address`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const base = await serveTitles(t);
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-browser"
      ? { ...set, sections: ["browser.tabs"], layout: "list" } : set) }, scope: "common" });
    await s.run("core.card.focus", { card: "browser" });
    const of = (sidebars) => sidebars.find((item) => item.sidebar === "right");
    const sidebars = await s.until("core.sidebars", (value) => of(value)?.sections.find((item) => item.id === "browser.tabs")?.mounted,
      "the right sidebar did not mount the tabs section");
    const surface = of(sidebars).surface;
    const label = (grid) => grid.cards.flatMap((card) => card.tabs).find((tab) => tab.id === surface)?.label;
    const section = (value) => of(value)?.sections.find((item) => item.id === "browser.tabs")?.text;

    await s.run("browser.navigate", { url: `${base}/titled` }, surface);
    await s.until("core.grid", (grid) => label(grid) === "titled", "the tab did not show the document title");
    await s.until("core.sidebars", (value) => section(value) === "titled", "the tabs section did not show the document title");
    await s.run("browser.navigate", { url: `${base}/untitled` }, surface);
    await s.until("core.grid", (grid) => label(grid) === `${base}/untitled`, "the tab did not show the address of an untitled document");
    await s.until("core.sidebars", (value) => section(value) === `${base}/untitled`, "the tabs section did not show the address");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: tabs-layout tabs keep their full names on one line at the strip height`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // 기본 사이드바 위치는 inset 이다. 레일 사이드바를 보려면 flow 로 둔다.
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    await s.run("core.settings.change", { key: "cardSidebar", value: "flow", scope: "common" });
    s.cleanup(() => s.run("core.settings.reset", { key: "sets" }));
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-shell" ? { ...set, layout: "tabs" } : set) },
      scope: "common" });
    const check = async (sidebar) => {
      const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === sidebar)?.layout === "tabs",
        `sidebar ${sidebar} did not draw tabs`);
      const tabbed = sidebars.filter((item) => item.layout === "tabs");
      const at = tabbed.findIndex((item) => item.sidebar === sidebar);
      const item = tabbed[at];
      assert.deepEqual(item.sections.filter((section) => section.clipped).map((section) => section.id), [],
        `${sidebar}: tabs clip their names`);
      const strip = await s.rect("core.sidebar.tabs", at);
      const first = tabbed.slice(0, at).reduce((sum, value) => sum + value.sections.length, 0);
      for (let index = 0; index < item.sections.length; index += 1) {
        const tab = await s.rect("core.sidebar.section.tab", first + index);
        assert.ok(near(tab.height, strip.height), `${sidebar}: tab ${item.sections[index].id} is ${tab.height} pt high in a ${strip.height} pt strip`);
      }
    };
    await check("rail-shell");
    // 우측 사이드바는 브라우저 카드에 포커스하면 tabs 레이아웃의 브라우저 세트를 보인다.
    await s.run("core.card.focus", { card: "browser" });
    await check("right");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a section header's name stays in place when sections fold and sits alike in every header`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // 기본 사이드바 위치는 inset 이다. 레일 사이드바를 보려면 flow 로 둔다.
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    await s.run("core.settings.change", { key: "cardSidebar", value: "flow", scope: "common" });
    s.cleanup(() => s.run("core.settings.reset", { key: "cardSidebar" }));
    // 좌측 세트(파일 트리, 북마크)는 문서에서 첫 list 사이드바다.
    const sidebars = await s.until("core.sidebars", (value) => value[0]?.sidebar === "left" && value[0].layout === "list"
      && value[0].sections.length >= 2, "the left sidebar did not draw two list sections");
    const [one, two] = sidebars[0].sections;
    const place = async (index) => {
      const header = await s.rect("core.sidebar.section.header", index);
      const name = await s.rect("core.sidebar.section.name", index);
      return { header, name, offset: [name.x - header.x, name.y - header.y, name.height] };
    };
    const first = await place(0);
    const second = await place(1);
    assert.deepEqual(second.offset, first.offset, "the second header places its name differently from the first");
    for (const [index, section] of [[0, one], [1, two]]) {
      const open = await place(index);
      await s.run("core.sidebar.section.fold", { sidebar: "left", section: section.id });
      await s.until("core.sidebars", (value) => value[0].sections[index].folded === true, `${section.id} did not fold`);
      const folded = await place(index);
      // fill 섹션이 자리를 받으면 머리가 옮겨질 수 있으므로 머리 안의 이름 자리를 비교한다.
      assert.deepEqual(folded.offset, open.offset, `${section.id}: the name moved inside its header when the section folded`);
      await s.run("core.sidebar.section.fold", { sidebar: "left", section: section.id });
      await s.until("core.sidebars", (value) => value[0].sections[index].folded === false, `${section.id} did not unfold`);
      assert.deepEqual((await place(index)).offset, open.offset, `${section.id}: the name moved inside its header when the section unfolded`);
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a fill section takes the sidebar height the other sections leave and gives it up when folded`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    // 좌측 세트는 파일 트리(fill)와 북마크(내용 높이)다. 좌측 사이드바는 문서에서 첫 사이드바다.
    const ready = (value) => value[0]?.sidebar === "left" && value[0].sections.every((item) => item.mounted);
    await s.until("core.sidebars", ready, "the left sidebar did not mount its sections");
    const measure = async () => {
      const box = await s.rect("core.sidebar", 0);
      const [tree, marks] = [await s.rect("core.sidebar.section", 0), await s.rect("core.sidebar.section", 1)];
      const [treeHead, marksHead] = [await s.rect("core.sidebar.section.header", 0), await s.rect("core.sidebar.section.header", 1)];
      return { box, tree, marks, treeHead, marksHead };
    };
    const open1 = await measure();
    // 트리 본문의 높이는 사이드바가 북마크와 트리 머리를 빼고 남긴 높이다.
    const room = open1.box.height - open1.marks.height - open1.treeHead.height;
    const body = open1.tree.height - open1.treeHead.height;
    assert.ok(Math.abs(body - room) <= 1, `the tree body is ${body} pt, the room is ${room} pt`);
    assert.ok(open1.marks.height < open1.box.height / 3, `the bookmarks section stretched to ${open1.marks.height} pt`);

    // 북마크를 접으면 트리가 그 자리를 받는다.
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.bookmarks" });
    await s.until("core.sidebars", (value) => value[0].sections[1].folded === true, "the bookmarks did not fold");
    const marksFolded = await measure();
    assert.ok(Math.abs(marksFolded.tree.height - (marksFolded.box.height - marksFolded.marksHead.height)) <= 1,
      `the tree is ${marksFolded.tree.height} pt after the bookmarks folded in a ${marksFolded.box.height} pt sidebar`);
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.bookmarks" });
    await s.until("core.sidebars", (value) => value[0].sections[1].folded === false, "the bookmarks did not unfold");

    // 트리를 접으면 머리만 남고, 내용 높이의 북마크는 늘어나지 않는다.
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.tree" });
    await s.until("core.sidebars", (value) => value[0].sections[0].folded === true, "the tree did not fold");
    const treeFolded = await measure();
    assert.ok(Math.abs(treeFolded.tree.height - treeFolded.treeHead.height) <= 0.5, "a folded tree kept more than its header");
    assert.ok(Math.abs(treeFolded.marks.height - open1.marks.height) <= 0.5,
      `the bookmarks changed from ${open1.marks.height} to ${treeFolded.marks.height} pt when the tree folded`);
    await s.run("core.sidebar.section.fold", { sidebar: "left", section: "files.tree" });
  });
}
