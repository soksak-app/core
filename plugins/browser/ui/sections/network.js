// 네트워크 섹션. 따라가는 표면 문서가 기록한 요청(browser.requests)의 형식, 주소, 걸린 시간을 보인다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  const stop = context.status("browser.requests", (requests, surface) => {
    if (surface === null) { list.replaceChildren(); list.textContent = "브라우저 표면 없음"; return; }
    if (!requests?.entries.length) { list.replaceChildren(); list.textContent = "요청 없음"; return; }
    const items = requests.entries.map((entry) => {
      const item = document.createElement("li");
      item.title = entry.url;
      item.textContent = `${entry.type} ${entry.url} ${Math.round(entry.duration)}ms`;
      return item;
    });
    if (requests.truncated) {
      const more = document.createElement("li");
      more.textContent = "요청이 더 있음";
      items.push(more);
    }
    list.replaceChildren(...items);
  });
  return { dispose() { stop(); list.remove(); } };
}
