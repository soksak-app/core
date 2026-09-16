// 브라우저 런타임. 네이티브 호스트가 없다.
//
// 페이지가 표면 자리를 직접 그리고, 표면과 모달 페이지는 열리지 않는다. 설정과
// 프로젝트 목록은 IndexedDB 에 저장한다.
import { WorkspaceStore } from "./browser-storage.js";

export const host = null;
export const page = null;

export const openStore = () => WorkspaceStore.open();
