// 작업 섹션. 끝나지 않은 shell.run 명령(shell.jobs)을 보이고, 중단 단추로 shell.interrupt 를 실행한다.
export function mount(root, context) {
  const list = document.createElement("ul");
  list.className = "section-list";
  root.append(list);
  const stop = context.status("shell.jobs", (jobs, surface) => {
    if (surface === null) { list.replaceChildren(); list.textContent = "셸 표면 없음"; return; }
    if (!jobs?.length) { list.replaceChildren(); list.textContent = "실행 중인 작업 없음"; return; }
    const items = jobs.map((job) => {
      const item = document.createElement("li");
      item.textContent = job.command;
      return item;
    });
    const control = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "중단";
    context.bind(button, "shell.interrupt", {});
    control.append(button);
    list.replaceChildren(...items, control);
  });
  return { dispose() { stop(); list.remove(); } };
}
