// 파일 플러그인 상태 모듈: 사이드카 목록으로 트리를 만들고, 펼침·새로 고침·북마크를 선언된 항목으로 공개한다.
import assert from "node:assert/strict";
import test from "node:test";

/** 가짜 문맥. listing 은 상대 경로마다 항목 배열이나 오류 문자열이다. */
function fakeContext(listing) {
  const statuses = new Map();
  const commands = new Map();
  const stored = {};
  let reply = null;
  const sent = [];
  const context = {
    project: { id: "p1", root: "/work/p1" },
    exposure: {
      status: (name, read, subscribe) => statuses.set(name, { read, subscribe }),
      command: (name, run) => commands.set(name, run),
    },
    sidecar: {
      on: async (fn) => { reply = fn; },
      send: async (body) => {
        sent.push(body);
        if (body.operation === "watch") { queueMicrotask(() => reply({ id: body.id })); return; }
        const value = listing[body.path];
        queueMicrotask(() => reply(typeof value === "string" ? { id: body.id, error: value } : { id: body.id, entries: value ?? [] }));
      },
    },
    data: {
      get: (key) => structuredClone(stored[key] ?? []),
      set: async (key, value) => { stored[key] = value; },
    },
  };
  return { context, statuses, commands, stored, sent, emit: (body) => reply(body) };
}

const listing = () => ({
  "": [{ name: "src", directory: true }, { name: "a.txt", directory: false }],
  src: [{ name: "main.go", directory: false }],
});

test("the state lists the project root, expands and folds a directory, and refreshes expanded directories", async () => {
  const files = listing();
  const f = fakeContext(files);
  const { mount } = await import("../ui/state.js");
  const mounted = await mount(f.context);
  const tree = () => f.statuses.get("files.tree").read();
  assert.deepEqual(tree(), { root: "/work/p1", error: null, entries: [
    { path: "src", name: "src", directory: true, depth: 0, expanded: false },
    { path: "a.txt", name: "a.txt", directory: false, depth: 0, expanded: false },
  ] });
  const seen = [];
  const stop = f.statuses.get("files.tree").subscribe((value) => seen.push(value));
  await f.commands.get("files.tree.toggle")({ path: "src" });
  assert.deepEqual(tree().entries.map((e) => [e.path, e.depth, e.expanded]),
    [["src", 0, true], ["src/main.go", 1, false], ["a.txt", 0, false]]);
  assert.equal(seen.length, 1);
  files.src = [{ name: "main.go", directory: false }, { name: "util.go", directory: false }];
  await f.commands.get("files.refresh")({});
  assert.deepEqual(tree().entries.map((e) => e.path), ["src", "src/main.go", "src/util.go", "a.txt"]);
  await f.commands.get("files.tree.toggle")({ path: "src" });
  assert.deepEqual(tree().entries.map((e) => e.path), ["src", "a.txt"]);
  await assert.rejects(f.commands.get("files.tree.toggle")({ path: "a.txt" }), /a.txt is not a listed directory/);
  stop();
  await mounted.dispose();
});

test("a root listing failure is reported in files.tree", async () => {
  const f = fakeContext({ "": "permission denied" });
  const { mount } = await import("../ui/state.js");
  await mount(f.context);
  assert.deepEqual(f.statuses.get("files.tree").read(), { root: "/work/p1", error: "permission denied", entries: [] });
});

test("bookmarks are stored as project data, kept unique, and removed", async () => {
  const f = fakeContext(listing());
  const { mount } = await import("../ui/state.js");
  await mount(f.context);
  const bookmarks = () => f.statuses.get("files.bookmarks").read();
  assert.deepEqual(bookmarks(), []);
  await f.commands.get("files.bookmarks.add")({ path: "a.txt" });
  await f.commands.get("files.bookmarks.add")({ path: "src" });
  await f.commands.get("files.bookmarks.add")({ path: "a.txt" });
  assert.deepEqual(bookmarks(), ["a.txt", "src"]);
  assert.deepEqual(f.stored.bookmarks, ["a.txt", "src"]);
  await f.commands.get("files.bookmarks.remove")({ path: "a.txt" });
  assert.deepEqual(bookmarks(), ["src"]);
  await assert.rejects(f.commands.get("files.bookmarks.remove")({ path: "none" }), /none is not bookmarked/);
});

test("the state watches the expanded directories, refreshes on a change, and stops watching on dispose", async () => {
  const files = listing();
  const f = fakeContext(files);
  const { mount } = await import("../ui/state.js");
  const mounted = await mount(f.context);
  const watched = () => f.sent.filter((body) => body.operation === "watch").at(-1)?.paths;
  assert.deepEqual(watched(), [""]);
  await f.commands.get("files.tree.toggle")({ path: "src" });
  assert.deepEqual(watched(), ["", "src"]);
  const seen = [];
  f.statuses.get("files.tree").subscribe((value) => seen.push(value.entries.map((e) => e.path)));
  files.src = [{ name: "main.go", directory: false }, { name: "new.go", directory: false }];
  f.emit({ changed: "src" });
  await f.commands.get("files.refresh")({});
  assert.deepEqual(seen[0], ["src", "src/main.go", "src/new.go", "a.txt"], "the change refreshed the tree before the next command");
  await f.commands.get("files.tree.toggle")({ path: "src" });
  assert.deepEqual(watched(), [""]);
  await mounted.dispose();
  assert.deepEqual(watched(), []);
});
