// DOM 섹션. 따라가는 표면 문서의 요소(browser.elements)를 깊이만큼 들여 tag#id.class 로 보인다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  const stop = context.status("browser.elements", (elements, surface) => {
    if (surface === null) { list.replaceChildren(); list.textContent = "브라우저 표면 없음"; return; }
    if (!elements?.nodes.length) { list.replaceChildren(); list.textContent = "요소 없음"; return; }
    const items = elements.nodes.map((node) => {
      const item = document.createElement("li");
      item.style.paddingLeft = `${node.depth * 8}px`;
      const classes = node.class.trim().split(/\s+/).filter(Boolean).map((name) => `.${name}`).join("");
      item.textContent = `${node.tag}${node.id ? `#${node.id}` : ""}${classes}`;
      return item;
    });
    if (elements.truncated) {
      const more = document.createElement("li");
      more.textContent = "요소가 더 있음";
      items.push(more);
    }
    list.replaceChildren(...items);
  });
  return { dispose() { stop(); list.remove(); } };
}
