// 실행 기록 섹션. 셸 세션에 쓴 줄(shell.history)을 보이고, 항목을 누르면 그 줄을 다시 쓴다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  const stop = context.status("shell.history", (lines, surface) => {
    if (surface === null) { list.replaceChildren(); list.textContent = "셸 표면 없음"; return; }
    if (!lines?.length) { list.replaceChildren(); list.textContent = "기록 없음"; return; }
    list.replaceChildren(...lines.map((line) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = line;
      context.bind(button, "shell.write", { data: `${line}\n` });
      item.append(button);
      return item;
    }));
  });
  return { dispose() { stop(); list.remove(); } };
}
