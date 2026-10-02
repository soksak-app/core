// 브라우저 애플리케이션의 시작 문서(docs/spec/native-host.md#page-start). 저장소를 top-level await 로 읽으므로 page
// 코드는 이 값이 준비된 뒤에 실행된다. 브라우저 탭에는 native 창 단추가 없다.
import { WorkspaceStore } from "./browser-storage.js";

const store = await WorkspaceStore.open({ channel: false });
const workspace = await store.snapshot();
store.close();

export default { workspace, controls: null };
