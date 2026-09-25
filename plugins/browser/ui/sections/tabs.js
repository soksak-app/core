// 탭 섹션. 실제 내용을 그리기 전까지 섹션이 받은 카드와 탭을 목록으로 보인다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  for (const text of ["탭: 내용 준비 중", `카드: ${context.card ?? "없음"}`, `탭: ${context.surface ?? "없음"}`]) {
    const item = document.createElement("li");
    item.textContent = text;
    list.append(item);
  }
  root.append(list);
  return { dispose: () => list.remove() };
}
