// 북마크 섹션. 상태 모듈이 공개한 files.bookmarks 를 그리고, 삭제를 누르면 files.bookmarks.remove 를 실행한다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  const stop = context.status("files.bookmarks", (paths, source) => {
    if (source === null) { list.replaceChildren(); list.textContent = "프로젝트 없음"; return; }
    if (!paths.length) { list.replaceChildren(); list.textContent = "북마크 없음"; return; }
    list.replaceChildren(...paths.map((path) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = path;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "삭제";
      item.append(name, context.bind(remove, "files.bookmarks.remove", { path }));
      return item;
    }));
  });
  return { dispose() { stop(); list.remove(); } };
}
