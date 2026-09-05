// 외부 페이지를 표시하는 표면과 그 플러그인이 등록하는 섹션.
//
// 표면의 대상은 이 호스트 외부의 URL 이다. 호스트는 그 주소를 그대로 열고 플러그인
// 종류는 알지 않는다.
import { registerPlugin, registerSection } from "./registry.js";

registerPlugin({
  id: "browser",
  name: "브라우저",
  mark: "www",
  svg: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.25h12M4.3 4.6h.01M6.1 4.6h.01"/>',
  surface: () => ({ url: "https://www.google.com" }),
});

registerSection({ id: "browser.dom", name: "DOM" });
registerSection({ id: "browser.network", name: "네트워크" });
registerSection({ id: "browser.tabs", name: "탭" });
registerSection({ id: "browser.history", name: "히스토리" });
