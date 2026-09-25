// 파일 트리 섹션. 상태 모듈이 공개한 files.tree 의 행을 그린다. 디렉터리를 누르면 files.tree.toggle,
// ☆ 를 누르면 files.bookmarks.add, 새로 고침을 누르면 files.refresh 를 실행한다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  // 같은 값이면 다시 그리지 않는다. 누르는 동안 요소를 바꾸면 그 누름은 명령을 실행하지 않는다.
  let drawn;
  const stop = context.status("files.tree", (tree, source) => {
    const key = JSON.stringify([tree, source]);
    if (key === drawn) return;
    drawn = key;
    if (source === null) { list.replaceChildren(); list.textContent = "프로젝트 없음"; return; }
    // 그릴 때마다 요소를 새로 만든다. 같은 요소를 다시 연결하면 누름 한 번이 명령을 여러 번 실행한다.
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "새로 고침";
    const head = document.createElement("li");
    head.append(context.bind(refresh, "files.refresh", {}));
    if (tree.error !== null) {
      const failure = document.createElement("li");
      failure.textContent = `오류: ${tree.error}`;
      list.replaceChildren(head, failure);
      return;
    }
    list.replaceChildren(head, ...tree.entries.map((entry) => {
      const item = document.createElement("li");
      item.style.paddingLeft = `${entry.depth * 12}px`;
      const control = document.createElement("button");
      control.type = "button";
      if (entry.directory) {
        control.textContent = `${entry.expanded ? "▾" : "▸"} ${entry.name}`;
        item.append(context.bind(control, "files.tree.toggle", { path: entry.path }));
      } else {
        const name = document.createElement("span");
        name.textContent = entry.name;
        control.textContent = "☆";
        control.title = "북마크에 추가";
        item.append(name, context.bind(control, "files.bookmarks.add", { path: entry.path }));
      }
      return item;
    }));
  });
  return { dispose() { stop(); list.remove(); } };
}
