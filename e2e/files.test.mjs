// 파일 플러그인 검사: 표면이 없는 플러그인의 상태 모듈이 프로젝트 폴더를 나열하고, 좌측 사이드바의 파일 트리와
// 북마크 섹션이 그 상태를 보이며, 섹션의 조작이 선언된 명령을 실행하고 북마크가 다시 읽은 뒤에도 남는지 검사한다.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

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
    const text = (sidebars, id) => sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === id)?.text;
    const rowIndex = (tree, path) => tree.entries.findIndex((entry) => entry.path === path);

    // 파일 트리: 상태 모듈이 프로젝트 폴더를 나열하고 섹션이 그 행을 보인다.
    await s.run("files.refresh");
    let tree = await s.until("files.tree", (value) => value?.root === project.root && rowIndex(value, folder) >= 0,
      "files.tree did not list the project folder");
    assert.equal(tree.error, null);
    let sidebars = await s.until("core.sidebars", (value) => text(value, "files.tree")?.includes(`▸ ${folder}`),
      "the file tree section did not show the folder");

    // 디렉터리를 네이티브 클릭으로 누르면 files.tree.toggle 이 펼친다.
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", 1 + rowIndex(tree, folder)));
    tree = await s.until("files.tree", (value) => rowIndex(value, `${folder}/note.txt`) >= 0,
      "a click on the folder did not expand it");
    sidebars = await s.until("core.sidebars", (value) => text(value, "files.tree")?.includes(`▾ ${folder}note.txt`),
      "the file tree section did not show the expanded folder");

    // 새 파일은 새로 고침 조작 뒤에 보인다.
    writeFileSync(join(directory, "added.txt"), "added\n");
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", 0));
    tree = await s.until("files.tree", (value) => rowIndex(value, `${folder}/added.txt`) >= 0,
      "a click on refresh did not list the new file");

    // 북마크: 파일의 ☆ 가 files.bookmarks.add 를 실행하고, 북마크 섹션이 보이며, 다시 읽은 뒤에도 남는다.
    const note = `${folder}/note.txt`;
    sidebars = await s.until("core.sidebars", (value) => text(value, "files.tree")?.includes("added.txt"),
      "the file tree section did not show the new file");
    await press(s, "core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", 1 + rowIndex(tree, note)));
    await s.until("files.bookmarks", (value) => value.includes(note), "a click on the star did not bookmark the file");
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
    await s.until("core.sidebars", (value) => !text(value, "files.bookmarks")?.includes(note),
      "the bookmarks section still shows the removed bookmark");
  });
}
