// 히스토리 섹션. 따라가는 표면의 세션 기록(browser.history)을 오래된 것부터 보이고, 항목을 누르면
// browser.history.go 로 그 항목을 연다. 현재 항목은 aria-current 로 표시한다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  const stop = context.status("browser.history", (history, surface) => {
    if (surface === null) { list.replaceChildren(); list.textContent = "브라우저 표면 없음"; return; }
    if (!history?.entries.length) { list.replaceChildren(); list.textContent = "기록 없음"; return; }
    list.replaceChildren(...history.entries.map((entry, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      // 기본값: 기록 제목이 비어 있으면 해당 항목의 주소를 표시한다.
      button.textContent = entry.title || entry.url;
      button.title = entry.url;
      if (index === history.index) button.setAttribute("aria-current", "page");
      context.bind(button, "browser.history.go", { index });
      item.append(button);
      return item;
    }));
  });
  return { dispose() { stop(); list.remove(); } };
}
