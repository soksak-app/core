// cwd 섹션. 셸 표면이 보고한 현재 디렉터리(shell.cwd)를 보인다.
export function mount(root, context) {
  const line = document.createElement("p");
  line.className = "section-line";
  root.append(line);
  const stop = context.status("shell.cwd", (cwd, surface) => {
    // 기본값: 셸이 첫 디렉터리를 보고하기 전의 shell.cwd 는 null 이므로 보고 전임을 보인다.
    line.textContent = surface === null ? "셸 표면 없음" : cwd ?? "디렉터리 보고 전";
  });
  return { dispose() { stop(); line.remove(); } };
}
