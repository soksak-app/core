// 북마크 섹션. 상태 모듈이 공개한 files.bookmarks 를 그리고, 삭제를 누르면 files.bookmarks.remove 를 실행한다.
// 섹션의 스타일. 경로는 남은 폭을 채우고 넘치면 말줄임으로 줄이며, 삭제 단추는 경로와 떨어져 행의 오른쪽에 선다.
const STYLE = `
.files-bookmarks{list-style:none;margin:0;padding:0}
.files-bookmarks__row{display:flex;align-items:center;gap:8px;min-height:24px}
.files-bookmarks__path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files-bookmarks__remove{flex:0 0 auto;padding:0 2px;border:0;background:none;color:var(--muted);font:inherit;cursor:pointer}
.files-bookmarks__remove:hover{color:var(--fg)}
`;

export function mount(root, context) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(STYLE);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const list = document.createElement("ul");
  list.className = "files-bookmarks";
  root.append(list);
  // 같은 값이면 다시 그리지 않는다. 누르는 동안 요소를 바꾸면 그 누름은 명령을 실행하지 않는다.
  let drawn;
  const stop = context.status("files.bookmarks", (paths, source) => {
    const key = JSON.stringify([paths, source]);
    if (key === drawn) return;
    drawn = key;
    if (source === null) { list.replaceChildren(); list.textContent = "프로젝트 없음"; return; }
    if (!paths.length) { list.replaceChildren(); list.textContent = "북마크 없음"; return; }
    list.replaceChildren(...paths.map((path) => {
      const item = document.createElement("li");
      item.className = "files-bookmarks__row";
      const name = document.createElement("span");
      name.className = "files-bookmarks__path";
      name.textContent = path;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "files-bookmarks__remove";
      remove.textContent = "삭제";
      item.append(name, context.bind(remove, "files.bookmarks.remove", { path }));
      return item;
    }));
  });
  return {
    dispose() {
      stop();
      list.remove();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet);
    },
  };
}
