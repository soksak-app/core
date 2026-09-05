// 셸이 뒤에 붙은 표면과, 그 표면이 기여하는 섹션들.
//
// 표면은 이 호스트가 서비스하는 문서다: 브라우저에서는 이 페이지가 표면을
// 흉내 내고, 앱에서는 호스트가 그 문서를 네이티브 뷰에 띄운다.
//
// 섹션은 등록만 한다. 어느 사이드바에 서는지는 사람이 세트로 묶고 설정에서
// 연결한다.
import { registerPlugin, registerSection } from "./registry.js";

registerPlugin({
  id: "terminal",
  name: "터미널",
  mark: ">_",
  svg: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.75L5 10M8.5 10.25H11"/>',
  surface: (cardId) => ({ page: `terminal.html?id=${encodeURIComponent(cardId)}` }),
});

registerSection({ id: "terminal.history", name: "실행 기록" });
registerSection({ id: "terminal.cwd", name: "cwd" });
registerSection({ id: "terminal.pty", name: "PTY" });
registerSection({ id: "terminal.jobs", name: "작업" });
