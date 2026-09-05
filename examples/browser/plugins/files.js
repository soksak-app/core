// 섹션만 등록하는 모듈.
//
// 표면이 없으므로 플러그인이 아니다. `+` 메뉴에 나타나지 않고 탭도 되지 않는다.
import { registerSection } from "./registry.js";

registerSection({ id: "files.tree", name: "파일 트리" });
registerSection({ id: "files.bookmarks", name: "북마크" });
