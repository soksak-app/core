// 섹션만 기여하는 것.
//
// 표면이 없으므로 플러그인이 아니다 — `+` 메뉴에 서지 않고 탭이 되지도
// 않는다. 사이드바에 설 수 있는 기능만 내놓는다.
import { registerSection } from "./registry.js";

registerSection({ id: "files.tree", name: "파일 트리" });
registerSection({ id: "files.bookmarks", name: "북마크" });
