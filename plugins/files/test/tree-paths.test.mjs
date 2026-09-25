// 파일 트리 섹션이 files.tree 의 행을 트리 라이브러리의 경로와 펼침으로 옮기는 규칙을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { PLACEHOLDER, pathDiff, treePaths, expansionRequests } from "../ui/sections/tree-paths.js";

const rows = [
  { path: "src", name: "src", directory: true, depth: 0, expanded: true },
  { path: "src/lib", name: "lib", directory: true, depth: 1, expanded: false },
  { path: "src/main.go", name: "main.go", directory: false, depth: 1, expanded: false },
  { path: "empty", name: "empty", directory: true, depth: 0, expanded: true },
  { path: "a.txt", name: "a.txt", directory: false, depth: 0, expanded: false },
];

test("a directory without listed children holds a placeholder so it can be opened", () => {
  assert.deepEqual(treePaths(rows), [`src/lib/${PLACEHOLDER}`, "src/main.go", `empty/${PLACEHOLDER}`, "a.txt"]);
});

test("the diff adds before it removes so a directory never loses its last child in between", () => {
  const before = treePaths([rows[0], { ...rows[1] }, rows[4]]);
  const after = treePaths([rows[0], { ...rows[1], expanded: true }, { path: "src/lib/x.go", name: "x.go", directory: false, depth: 2, expanded: false }, rows[4]]);
  assert.deepEqual(pathDiff(before, after), [
    { type: "add", path: "src/lib/x.go" },
    { type: "remove", path: `src/lib/${PLACEHOLDER}` },
  ]);
  assert.deepEqual(pathDiff(after, after), []);
});

test("a directory opened or closed in the tree asks for files.tree.toggle once until the state follows", () => {
  const open = new Set(["src", "src/lib"]);
  const pending = new Set();
  assert.deepEqual(expansionRequests(rows, (path) => open.has(path), pending), ["src/lib", "empty"]);
  assert.deepEqual(expansionRequests(rows, (path) => open.has(path), pending), [], "a pending request is not repeated");
  const followed = rows.map((row) => (row.path === "src/lib" ? { ...row, expanded: true } : row));
  assert.deepEqual(expansionRequests(followed, (path) => open.has(path), pending), [], "empty stays pending");
  assert.equal(pending.has("src/lib"), false, "a followed request leaves pending");
});
