import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// 폴더를 읽을 수 없는 프로젝트는 라이브러리가 열기 전에 그 까닭을 보이고 core.library 에 보고하며, 라이브러리에서 제거할 수 있다.
test("a project whose folder cannot be read shows the reason in the library and can be removed there", async (t) => {
  const dom = new JSDOM("<body><div id=library></div></body>");
  globalThis.document = dom.window.document;
  const project = { id: "prj-a", title: "test", root: "/work/missing", spaces: [{ id: "s" }], activeSpaceId: "s" };
  const closed = [];
  const present = { id: "prj-b", title: "here", root: "/work/here", spaces: [{ id: "s" }], activeSpaceId: "s" };
  t.mock.module("../projects.js", { namedExports: {
    inLibrary: () => true, all: () => [project, present], isOpen: () => false, active: () => null,
    close: async (id) => { closed.push(id); },
  } });
  t.mock.module("../plane.js", { namedExports: { fresh: () => ({}) } });
  t.mock.module("@soksak/runtime", { namedExports: { windows: { createsFolders: false,
    folder: async (root) => {
      if (root === "/work/missing") throw new Error("project directory does not exist: /work/missing");
      return { root, identity: "id" };
    } } } });
  t.mock.module("../library-preview.js", { namedExports: { preview: () => {
    const el = document.createElement("div"); el.className = "library-preview"; return el;
  } } });
  t.mock.module("../commands.js", { namedExports: { delegate: () => {}, mark: (element, command, params) => {
    element.dataset.command = command; element.dataset.params = JSON.stringify(params);
  } } });
  t.mock.module("../icons.js", { namedExports: { icon: () => "" } });
  // 라이브러리의 플러그인 페이지가 쓰는 작업 상태. 이 검사는 프로젝트 페이지만 본다.
  t.mock.module("../installed-plugins.js", { namedExports: {
    pluginOperations: { hosted: false, status: () => ({ plugins: [], operation: null }), failure: () => null, refresh: async () => {} },
    onPluginOperations: () => {},
  } });
  const { createLibrary } = await import("../library.js?folders");
  const library = createLibrary(document.getElementById("library"));
  library.render();
  await new Promise((resolve) => setImmediate(resolve));
  const state = library.state();
  assert.deepEqual(state.folderErrors, { "prj-a": "project directory does not exist: /work/missing" });
  const card = document.querySelector('[data-project-id="prj-a"]');
  // 경로는 카드의 경로 줄에 한 번만 보인다.
  assert.equal(card.querySelector(".library-project__missing")?.textContent, "폴더가 없습니다.");
  assert.equal(document.querySelector('[data-project-id="prj-b"] .library-project__missing'), null);
  assert.equal(card.querySelector('[data-expose="core.library.open"]').disabled, true, "the card of a missing folder can still be pressed");
  assert.equal(document.querySelector('[data-project-id="prj-b"] [data-expose="core.library.open"]').disabled, false);
  const remove = card.querySelector('[data-expose="core.library.remove"]');
  assert.deepEqual([remove?.dataset.command, remove?.dataset.params], ["core.library.remove", JSON.stringify({ id: "prj-a" })],
    "the library card has no remove control bound to core.library.remove");
  await library.actions.remove("prj-a");
  assert.deepEqual(closed, ["prj-a"]);
  dom.window.close();
});
