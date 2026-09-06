// 셸 프로세스가 연결된 표면과 그 플러그인이 등록하는 섹션.
//
// 표면은 이 호스트가 서비스하는 문서다. 브라우저에서는 페이지가 모사하고,
// 애플리케이션에서는 호스트가 네이티브 뷰에 로드한다.
//
// 섹션은 등록만 한다. 어느 사이드바에 표시할지는 설정의 세트와 링크가 정한다.
import { registerPlugin, registerSection } from "./registry.js";

registerPlugin({
  id: "terminal",
  name: "터미널",
  mark: ">_",
  svg: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.75L5 10M8.5 10.25H11"/>',
  surface: (tabId) => ({ page: `terminal.html?id=${encodeURIComponent(tabId)}` }),
});

registerSection({ id: "terminal.history", name: "실행 기록" });
registerSection({ id: "terminal.cwd", name: "cwd" });
registerSection({ id: "terminal.pty", name: "PTY" });
registerSection({ id: "terminal.jobs", name: "작업" });
