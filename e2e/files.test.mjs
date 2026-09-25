// 파일 플러그인 검사: 표면이 없는 플러그인의 상태 모듈이 프로젝트 폴더를 나열하고, 좌측 사이드바의 파일 트리가
// @pierre/trees 로 그 상태를 그리며, 트리 안의 네이티브 클릭이 폴더를 열고 파일을 고르고, 디스크의 변경과 git
// 상태가 새로 고침 없이 따라오며, 북마크가 다시 읽은 뒤에도 남는지 검사한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

/* 파일 트리 섹션의 조작 요소 순서: ☆, 새로 고침, 트리를 담은 요소. */
const STAR = 0;
const REFRESH = 1;
const HOLDER = 2;
/* 트리를 담은 요소의 높이는 보이는 행 수 × 행 높이 + 8pt 다(plugins/files/ui/sections/tree.js). */
const HOLDER_PADDING = 8;

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

    /** 트리의 행 at 의 가운데를 네이티브 클릭으로 누른다. 행 높이는 담은 요소의 높이에서 얻는다. */
    const clickRow = async (value, path) => {
      const sidebars = await s.get("core.sidebars");
      const holder = await s.rect("core.sidebar.section.control", controlIndex(sidebars, "left", "files.tree", HOLDER));
      const height = (holder.height - HOLDER_PADDING) / value.entries.length;
      const at = rowIndex(value, path);
      assert.ok(at >= 0, `${path} is not a row`);
      await s.click(holder.x + holder.width / 2, holder.y + (at + 0.5) * height);
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
