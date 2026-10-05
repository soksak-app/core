// 파일 플러그인 검사: 표면이 없는 플러그인의 상태 모듈이 프로젝트 폴더를 나열하고, 좌측 사이드바의 파일 트리가
// @pierre/trees 로 그 상태를 그리며, 트리 안의 네이티브 클릭이 폴더를 열고 파일을 고르고, 디스크의 변경과 git
// 상태가 새로 고침 없이 따라오며, 북마크가 다시 읽은 뒤에도 남는지 검사한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, coveredBy, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCardSidebar } from "./fixture.mjs";
import { distance, readPng } from "@soksak/window-check/png.mjs";

/** 요소의 가운데를 네이티브 입력으로 누른다. */
const press = async (s, name, index) => {
  const rect = await s.rect(name, index);
  assert.ok(rect.width > 0 && rect.height > 0, `${name} ${index} has no area`);
  await s.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
};

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

/* 파일 트리 섹션의 조작 요소 순서: 선택을 받는 섹션 상자, 별, 새로 고침, 트리를 담은 요소. */
const STAR = 1;
const REFRESH = 2;
const HOLDER = 3;
/* 트리 행의 높이(pt). 사이드바 목록의 행 높이다(files plugin repository 의 ui/sections/tree.js). */
const ROW = 20;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the files sections show the project folder and its bookmarks from the files state`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const project = await s.get("core.project");
    const folder = `files-check-${process.pid}`;
    const directory = join(project.root, folder);
    mkdirSync(directory);
    writeFileSync(join(directory, "note.txt"), "note\n");
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q"], { cwd: project.root });
    s.cleanup(() => rmSync(join(project.root, ".git"), { recursive: true, force: true }));
    const text = (sidebars, id) => sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === id)?.text;
    const rowIndex = (tree, path) => tree.entries.findIndex((entry) => entry.path === path);

    // 파일 트리: 상태 모듈이 프로젝트 폴더를 나열하고, git 상태가 저장소의 새 파일을 untracked 로 보고한다.
    await s.run("files.refresh");
    let tree = await s.until("files.tree", (value) => value?.root === project.root && rowIndex(value, folder) >= 0,
      "files.tree did not list the project folder");
    assert.equal(tree.error, null);
    await s.until("files.git", (value) => value.some((entry) => entry.path === `${folder}/note.txt` && entry.status === "untracked"),
      "files.git did not report the untracked file");

    /** 트리의 행 path 의 가운데를 네이티브 클릭으로 누른다. 행은 담은 요소의 위에서부터 ROW 간격이다. */
    const clickRow = async (value, path) => {
      const sidebars = await s.get("core.sidebars");
      const holder = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", HOLDER));
      const at = rowIndex(value, path);
      assert.ok(at >= 0, `${path} is not a row`);
      await s.click(holder.x + holder.width / 2, holder.y + (at + 0.5) * ROW);
    };

    // 트리의 폴더를 네이티브 클릭으로 열면 files.tree.toggle 이 그 폴더를 나열한다.
    await clickRow(tree, folder);
    tree = await s.until("files.tree", (value) => rowIndex(value, `${folder}/note.txt`) >= 0,
      "a click on the folder in the tree did not open it");

    // 애플리케이션 밖에서 만들거나 지운 파일은 감시로 새로 고침 없이 나타나고 사라지며, git 상태도 따라온다.
    writeFileSync(join(directory, "watched.txt"), "watched\n");
    await s.until("files.tree", (value) => rowIndex(value, `${folder}/watched.txt`) >= 0,
      "a file created on disk did not appear without a refresh");
    await s.until("files.git", (value) => value.some((entry) => entry.path === `${folder}/watched.txt`),
      "files.git did not follow the created file");
    rmSync(join(directory, "watched.txt"));
    tree = await s.until("files.tree", (value) => rowIndex(value, `${folder}/watched.txt`) < 0,
      "a file removed on disk did not leave without a refresh");

    // 새로 고침 조작이 files.refresh 를 실행한다.
    let sidebars = await s.get("core.sidebars");
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", REFRESH));

    // 북마크: 트리에서 파일을 고르고 ☆ 를 누르면 files.bookmarks.add 가 실행되고, 다시 읽은 뒤에도 남는다.
    const note = `${folder}/note.txt`;
    tree = await s.get("files.tree");
    await clickRow(tree, note);
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", STAR));
    await s.until("files.bookmarks", (value) => value.includes(note), "the star did not bookmark the selected file");
    s.cleanup(async () => {
      if ((await s.get("files.bookmarks")).includes(note)) await s.run("files.bookmarks.remove", { path: note });
    });
    await s.until("core.sidebars", (value) => text(value, "files.bookmarks")?.includes(note),
      "the bookmarks section did not show the bookmark");
    await s.run("core.projects.flush");
    const before = (await s.get("core.window.document")).timeOrigin;
    await s.run("host.window.reload");
    await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
      "the main document did not reload");
    sidebars = await s.until("core.sidebars", (value) => text(value, "files.bookmarks")?.includes(note),
      "the bookmark did not survive a reload");

    // 삭제 조작이 files.bookmarks.remove 를 실행한다.
    const bookmarks = await s.get("files.bookmarks");
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, "left", "files.bookmarks", bookmarks.indexOf(note)));
    await s.until("files.bookmarks", (value) => !value.includes(note), "a click on 삭제 did not remove the bookmark");
  });
}

/** 캡처의 한 줄 띠에서 바탕과 다른 첫 열(pt). band 는 pt 사각형, 바탕은 띠 왼쪽 끝의 색이다. */
function firstInk(image, scale, band, { from = band.x, to = band.x + band.width } = {}) {
  const background = image.pixel(Math.round(from * scale) + 1, Math.round((band.y + band.height / 2) * scale));
  for (let x = Math.round(from * scale); x < Math.round(to * scale); x++) {
    for (let y = Math.round(band.y * scale) + 2; y < Math.round((band.y + band.height) * scale) - 2; y++) {
      if (distance(image.pixel(x, y), background) > 48) return x / scale;
    }
  }
  return null;
}

/** 띠 안의 잉크 열 묶음. gap 장치 픽셀 이상 떨어진 열은 다른 묶음이다. 묶음마다 [시작, 끝] 장치 픽셀이다. */
function inkRuns(image, scale, band, gap) {
  const left = Math.round(band.x * scale);
  const background = image.pixel(left + 1, Math.round((band.y + band.height / 2) * scale));
  const runs = [];
  for (let x = left; x < Math.round((band.x + band.width) * scale); x++) {
    let ink = false;
    for (let y = Math.round(band.y * scale) + 1; y < Math.round((band.y + band.height) * scale) - 1 && !ink; y++) {
      ink = distance(image.pixel(x, y), background) > 48;
    }
    if (!ink) continue;
    const last = runs.at(-1);
    if (last && x - last[1] <= gap) last[1] = x;
    else runs.push([x, x]);
  }
  return runs;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the file tree section keeps one horizontal grid and the sidebar's 12-point rows`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const project = await s.get("core.project");
    // 이름 전체가 잉크 덩어리 하나로 측정되도록 마침표를 쓰지 않는다. 마침표 앞뒤의 빈칸은 덩어리를 나누고, 나뉜 위치는
    // 서브픽셀 위치에 따라 행마다 달라진다.
    const name = `grid-${process.pid}`;
    writeFileSync(join(project.root, name), "grid\n");
    s.cleanup(() => rmSync(join(project.root, name), { force: true }));
    await s.run("files.refresh");
    const tree = await s.until("files.tree", (value) => value?.entries.some((entry) => entry.path === name), "the tree did not list the file");
    await s.run("files.bookmarks.add", { path: name });
    s.cleanup(() => s.run("files.bookmarks.remove", { path: name }));
    const sidebars = await s.until("core.sidebars", (value) => value.find((item) => item.sidebar === "left")
      ?.sections.find((item) => item.id === "files.bookmarks")?.text.includes(name), "the bookmark did not show");
    await s.presented();
    const { path } = await s.request("diagnostics.capture.still", {});
    s.cleanup(() => rmSync(dirname(path), { recursive: true, force: true }));
    const image = readPng(path);
    const scale = image.width / (await s.get("host.window")).content.width;

    // 섹션 머리: list 레이아웃의 머리 중 좌측 사이드바 files.tree 의 머리.
    let headerIndex = 0;
    for (const item of sidebars.filter((value) => value.layout === "list")) {
      if (item.sidebar === "left") { headerIndex += item.sections.findIndex((value) => value.id === "files.tree"); break; }
      headerIndex += item.sections.length;
    }
    const header = await s.rect("core.sidebar.section.header", headerIndex);
    const holder = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", HOLDER));
    const star = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", STAR));
    // 격자는 섹션 머리의 접기 표시가 그려진 첫 열이다. 머리 글자와 트리 행의 첫 표시도 그 열에서 시작한다.
    const chevron = firstInk(image, scale, header);
    const grid = chevron;
    const title = firstInk(image, scale, { x: holder.x, y: star.y, width: star.x - holder.x, height: star.height });
    const row = firstInk(image, scale, { x: holder.x, y: holder.y, width: holder.width / 2, height: ROW });
    const measured = { header: header.x, chevron, title, row };
    assert.ok(chevron !== null && Math.abs(chevron - header.x - 10) <= 4, `the section chevron is not near its 10-point padding: ${JSON.stringify(measured)}`);
    for (const [label, x] of Object.entries({ title, row })) {
      assert.ok(x !== null && Math.abs(x - grid) <= 1, `${label} starts at ${x}, not at the grid ${grid}: ${JSON.stringify(measured)}`);
    }
    assert.ok(holder.x <= header.x + 0.5 && holder.width >= header.width - 1, `the section body pads the tree: holder ${JSON.stringify(holder)}, header ${JSON.stringify(header)}`);

    // 글자 크기: 같은 이름을 12pt 사이드바 글자로 그린 북마크 행과 트리 행의 잉크 폭이 같다. 각 행의 마지막 덩어리가 이름 전체다.
    // 1배율 캡처에서 12pt 글자 사이의 빈칸은 3px 까지 생기고, 아이콘과 이름 사이의 빈칸은 8pt 이므로 4pt 이하의 빈칸을 잇는다.
    const WORD_GAP = 4;
    const at = tree.entries.findIndex((entry) => entry.path === name);
    const treeRuns = inkRuns(image, scale, { x: holder.x, y: holder.y + at * ROW, width: holder.width, height: ROW }, WORD_GAP * scale);
    const bookmarks = await s.get("files.bookmarks");
    const remove = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.bookmarks", bookmarks.indexOf(name)));
    const bookmarkRuns = inkRuns(image, scale, { x: header.x, y: remove.y, width: remove.x - header.x - 2, height: remove.height }, WORD_GAP * scale);
    // 북마크의 삭제 단추는 경로와 떨어져 있다. 행 전체에서 단추 왼쪽 경계 앞의 마지막 잉크 열과 경계부터의 첫 잉크 열
    // 사이를 잰다. 경계를 넘는 덩어리는 경계에서 나눈다.
    const rowRuns = inkRuns(image, scale, { x: header.x, y: remove.y, width: remove.x + remove.width - header.x, height: remove.height }, 0);
    const boundary = Math.round(remove.x * scale);
    const pathEnd = Math.max(...rowRuns.filter(([start]) => start < boundary).map(([, end]) => Math.min(end, boundary - 1)));
    const removeStart = Math.min(...rowRuns.filter(([, end]) => end >= boundary).map(([start]) => Math.max(start, boundary)));
    const separation = (removeStart - pathEnd - 1) / scale;
    assert.ok(separation >= 6, `the bookmark remove button is ${separation} pt from its path: runs ${JSON.stringify(rowRuns)}, remove ${JSON.stringify(remove)}`);
    const width = ([start, end]) => (end - start + 1) / scale;
    const treeLabel = width(treeRuns.at(-1));
    const bookmarkLabel = width(bookmarkRuns.at(-1));
    // 이름의 양 끝은 안티에일리어싱으로 각각 1 장치 픽셀까지 달라진다. 허용 폭은 2 장치 픽셀(2배율에서 1pt)이며,
    // 1pt 큰 글자는 이 이름에서 약 6pt 넓으므로 구분된다.
    assert.ok(Math.abs(treeLabel - bookmarkLabel) <= 2 / scale,
      `the tree row label is ${treeLabel} pt wide and the 12-point bookmark label ${bookmarkLabel} pt (scale ${scale}): tree runs ${JSON.stringify(treeRuns)}, bookmark runs ${JSON.stringify(bookmarkRuns)}`);

    // 트리는 사이드바가 준 높이를 채운다.
    const section = await s.rect("core.sidebar.section", headerIndex);
    assert.ok(holder.y + holder.height >= section.y + section.height - 1,
      `the tree ends at ${holder.y + holder.height}, before its section ends at ${section.y + section.height}`);
  });
}

/** 캡처에서 트리를 담은 요소의 위에서부터 잉크가 있는 행의 수. 첫 빈 행에서 멈춘다. */
function drawnRows(image, scale, holder) {
  let rows = 0;
  while ((rows + 1) * ROW <= holder.height) {
    const band = { x: holder.x, y: holder.y + rows * ROW, width: holder.width, height: ROW };
    if (inkRuns(image, scale, band, 1).length === 0) break;
    rows++;
  }
  return rows;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: two mounted trees of one project show files.tree and bookmark through native clicks`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    await terminalCardSidebar(s);
    // 터미널 카드의 안쪽 왼쪽 사이드바에 파일 트리만 둔다. 좌측 고정 사이드바의 트리와 함께 둘이 마운트된다.
    const sets = (await s.get("core.settings")).values.sets;
    await s.run("core.settings.set", { patch: { sets: sets.map((set) => set.id === "set-files" ? { ...set, sections: ["files.tree"] } : set) },
      scope: "common" });
    const project = await s.get("core.project");
    const folder = `pair-${process.pid}`;
    const directory = join(project.root, folder);
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "a\n");
    s.cleanup(() => rmSync(directory, { recursive: true, force: true }));
    await s.run("files.refresh");
    let tree = await s.until("files.tree", (value) => value?.entries.some((entry) => entry.path === folder),
      "files.tree did not list the folder");
    const mountedTrees = (value) => ["left", "terminal:left"].every((id) => value.find((item) => item.sidebar === id)
      ?.sections.find((item) => item.id === "files.tree")?.mounted);
    // 트리는 files.tree 값을 받은 콜백에서 머리 제목을 적고 같은 콜백에서 행을 바꾼다. 두 트리의 제목이 보이면
    // 두 트리가 값을 받은 것이다.
    const titled = (value) => mountedTrees(value) && ["left", "terminal:left"].every((id) => value.find((item) => item.sidebar === id)
      ?.sections.find((item) => item.id === "files.tree")?.text.includes(project.root.split("/").at(-1)));
    let sidebars = await s.until("core.sidebars", titled, "the left and inset trees did not receive files.tree");
    const holders = async () => {
      const value = await s.get("core.sidebars");
      return Promise.all(["left", "terminal:left"].map((id) =>
        s.rect("core.sidebar.section.control", controlIndex(value, id, "files.tree", HOLDER))));
    };
    /** 두 트리가 그린 행의 수. 캡처는 검사가 끝나기 전에 지운다. */
    const rowsDrawn = async () => {
      await s.presented();
      const window = await s.get("host.window");
      if (window.occluded) throw new Error(`${app.name}'s window is completely covered by ${coveredBy(s, window)}; nothing was measured`);
      const { path } = await s.request("diagnostics.capture.still", {});
      try {
        const image = readPng(path);
        const scale = image.width / (await s.get("host.window")).content.width;
        const header = await s.rect("core.sidebar.section.header", 0);
        if (firstInk(image, scale, header) === null) {
          throw new Error(`${app.name}'s capture shows no page (window ${JSON.stringify({ occluded: window.occluded, active: window.active, key: window.key })}); nothing was measured`);
        }
        return (await holders()).map((holder) => drawnRows(image, scale, holder));
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    };
    const same = async (what) => {
      const value = await s.get("files.tree");
      const drawn = await rowsDrawn();
      assert.deepEqual(drawn, [value.entries.length, value.entries.length],
        `${what}: the left and inset trees drew ${drawn} rows for ${value.entries.length} entries ${JSON.stringify(value.entries.map((e) => e.path))} of ${value.root} (error ${value.error})`);
      return value;
    };
    await same("after the listing");

    // inset 트리에서 폴더를 네이티브 클릭으로 열면 files.tree 가 펼치고, 두 트리가 같이 펼친다.
    const [, inset] = await holders();
    const at = tree.entries.findIndex((entry) => entry.path === folder);
    await s.click(inset.x + inset.width / 2, inset.y + (at + 0.5) * ROW);
    tree = await s.until("files.tree", (value) => value.entries.some((entry) => entry.path === `${folder}/a.txt`),
      "a click on the folder in the inset tree did not open it");
    await same("after the inset tree opened the folder");

    // 디스크에서 지운 폴더는 두 트리에서 함께 사라진다.
    rmSync(directory, { recursive: true, force: true });
    tree = await s.until("files.tree", (value) => !value.entries.some((entry) => entry.path.startsWith(folder)),
      "the removed folder stayed in files.tree");
    await same("after the folder was removed on disk");

    // 북마크: inset 트리에서 파일을 네이티브 클릭으로 고르고 inset 트리의 별을 누른다.
    mkdirSync(directory);
    writeFileSync(join(directory, "a.txt"), "a\n");
    await s.until("files.tree", (value) => value.entries.some((entry) => entry.path === folder), "the folder did not come back");
    sidebars = await s.get("core.sidebars");
    const [, insetNow] = await holders();
    const clickInset = async (value, path) => {
      const index = value.entries.findIndex((entry) => entry.path === path);
      assert.ok(index >= 0, `${path} is not a row`);
      await s.click(insetNow.x + insetNow.width / 2, insetNow.y + (index + 0.5) * ROW);
    };
    // 다른 카드가 포커스를 가진 채로 inset 트리를 누른다. 누름이 셸 카드에 포커스를 옮기며 사이드바를 다시 그린다.
    await s.run("core.card.focus", { card: "browser" });
    await clickInset(await s.get("files.tree"), folder);
    const file = { path: `${folder}/a.txt` };
    await clickInset(await s.until("files.tree", (value) => value.entries.some((entry) => entry.path === file.path),
      "the inset tree did not open the folder again"), file.path);
    // 선택은 프로젝트의 상태여서 두 트리가 함께 보이고, 어느 트리의 별도 그 파일을 북마크한다.
    await s.until("files.selection", (value) => value === file.path, "the selection in the inset tree did not reach files.selection");
    const star = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", STAR));
    await s.click(star.x + star.width / 2, star.y + star.height / 2);
    await s.until("files.bookmarks", (value) => value.includes(file.path),
      `a native click on ${file.path} in the inset tree and on the left tree's star did not bookmark it`);
    s.cleanup(() => s.run("files.bookmarks.remove", { path: file.path }));
  });
}
