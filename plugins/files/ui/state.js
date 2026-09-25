// 파일 플러그인의 상태 모듈(docs/spec/plugins.md#plugin-state). 파일 사이드카로 프로젝트 폴더를 나열해
// files.tree 를 만들고, 펼친 디렉터리를 감시해 바뀌면 다시 나열하며, 북마크를 프로젝트 데이터 bookmarks 에 저장해 files.bookmarks 로 공개한다.
export async function mount(context) {
  /* 펼친 디렉터리의 상대 경로. "" 는 프로젝트 폴더다. */
  const expanded = new Set([""]);
  /* 나열한 디렉터리마다 항목. */
  const listings = new Map();
  let error = null;
  /* 프로젝트 폴더의 git 상태. 폴더가 저장소가 아니면 비어 있다. */
  let git = [];
  const pending = new Map();
  let next = 0;
  const listeners = { tree: new Set(), bookmarks: new Set(), git: new Set() };

  await context.sidecar.on((body) => {
    // 감시한 디렉터리가 바뀌었거나 감시가 도중에 실패했다(docs/spec/sidecars.md#files).
    if (body.changed !== undefined) { inTurn(refresh).catch(showFailure); return; }
    if (body.id === undefined) { showFailure(new Error(body.error)); return; }
    const request = pending.get(body.id);
    if (!request) return;
    pending.delete(body.id);
    if (body.error !== undefined) request.reject(new Error(body.error));
    else request.resolve(body.entries);
  });
  const request = (body) => new Promise((resolve, reject) => {
    const id = `${body.operation}-${++next}`;
    pending.set(id, { resolve, reject });
    context.sidecar.send({ ...body, id }).catch((failure) => {
      pending.delete(id);
      reject(failure);
    });
  });
  const list = (path) => request({ operation: "list", path });
  /** 사이드카가 감시하는 디렉터리를 펼친 디렉터리로 바꾼다. */
  const watchExpanded = () => request({ operation: "watch", paths: [...expanded] });
  const join = (parent, name) => (parent ? `${parent}/${name}` : name);

  function rows(path = "", depth = 0) {
    return (listings.get(path) ?? []).flatMap((entry) => {
      const child = join(path, entry.name);
      const open = entry.directory && expanded.has(child);
      const row = { path: child, name: entry.name, directory: entry.directory, depth, expanded: open };
      return open ? [row, ...rows(child, depth + 1)] : [row];
    });
  }
  const tree = () => ({ root: context.project.root, error, entries: rows() });
  const bookmarks = () => context.data.get("bookmarks");
  const notify = (name, read) => { const value = read(); for (const fn of listeners[name]) fn(value); };
  /** 요청 없이 생긴 실패는 files.tree 의 error 로 보인다. */
  const showFailure = (failure) => { error = failure.message; notify("tree", tree); };

  /** 펼친 디렉터리를 모두 다시 나열한다. 사라진 하위 디렉터리는 접는다. 프로젝트 폴더의 실패는 error 로 보인다. */
  async function refresh() {
    listings.clear();
    error = null;
    for (const path of [...expanded].sort((a, b) => a.length - b.length)) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (path && !(listings.get(parent) ?? []).some((entry) => entry.directory && join(parent, entry.name) === path)) {
        expanded.delete(path);
        continue;
      }
      try {
        listings.set(path, await list(path));
      } catch (failure) {
        if (path) { expanded.delete(path); continue; }
        error = failure.message;
      }
    }
    await watchExpanded();
    notify("tree", tree);
    git = await request({ operation: "git" });
    notify("git", () => git);
  }

  // 새로 고침, 펼침, 변경 알림은 나열 결과를 함께 바꾸므로 받은 순서대로 하나씩 실행한다.
  let turn = Promise.resolve();
  const inTurn = (work) => {
    const done = turn.then(work);
    turn = done.then(() => undefined, () => undefined);
    return done;
  };
  const watch = (name) => (fn) => { listeners[name].add(fn); return () => listeners[name].delete(fn); };
  context.exposure.status("files.tree", tree, watch("tree"));
  context.exposure.status("files.bookmarks", bookmarks, watch("bookmarks"));
  context.exposure.status("files.git", () => git, watch("git"));
  context.exposure.command("files.refresh", () => inTurn(async () => { await refresh(); return null; }));
  context.exposure.command("files.tree.toggle", ({ path }) => inTurn(async () => {
    const row = rows().find((entry) => entry.path === path);
    if (!row?.directory) throw new Error(`${path} is not a listed directory`);
    if (expanded.has(path)) {
      for (const open of [...expanded]) if (open === path || open.startsWith(`${path}/`)) expanded.delete(open);
    } else {
      listings.set(path, await list(path));
      expanded.add(path);
    }
    await watchExpanded();
    notify("tree", tree);
    return null;
  }));
  context.exposure.command("files.bookmarks.add", async ({ path }) => {
    const current = bookmarks();
    if (!current.includes(path)) await context.data.set("bookmarks", [...current, path]);
    notify("bookmarks", bookmarks);
    return null;
  });
  context.exposure.command("files.bookmarks.remove", async ({ path }) => {
    const current = bookmarks();
    if (!current.includes(path)) throw new Error(`${path} is not bookmarked`);
    await context.data.set("bookmarks", current.filter((item) => item !== path));
    notify("bookmarks", bookmarks);
    return null;
  });
  await inTurn(refresh);
  return {
    async dispose() {
      listeners.tree.clear();
      listeners.bookmarks.clear();
      listeners.git.clear();
      await inTurn(() => request({ operation: "watch", paths: [] }));
    },
  };
}
