// 탭 섹션. core.grid 에서 섹션이 받은 탭(context.surface)을 가진 카드의 브라우저 탭을 보이는 제목과 함께 보이고, 탭을 누르면
// core.tab.select 로 그 탭을 고른다. 활성 탭은 aria-current 로 표시한다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  const stop = context.status("core.grid", (grid) => {
    const card = grid?.cards.find((item) => item.tabs.some((tab) => tab.id === context.surface));
    // 기본값: 섹션의 표면이 격자의 어느 카드에도 없으면(표면이 닫히는 중) 보일 탭이 없다.
    const tabs = card?.tabs.filter((tab) => tab.plugin === "browser") ?? [];
    if (!tabs.length) { list.replaceChildren(); list.textContent = "브라우저 탭 없음"; return; }
    list.replaceChildren(...tabs.map((tab) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      // 기본값: core.grid 의 label 은 문서가 알린 제목이며 알리기 전에는 null 이므로 탭 이름을 보인다.
      button.textContent = tab.label ?? tab.title;
      if (tab.id === card.active) button.setAttribute("aria-current", "page");
      context.bind(button, "core.tab.select", { tab: tab.id });
      item.append(button);
      return item;
    }));
  });
  return { dispose() { stop(); list.remove(); } };
}
