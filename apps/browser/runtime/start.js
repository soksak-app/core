// Start document of the browser application (docs/spec/native-host.md#page-start). The store is read with top-level await, so the page
// code runs after this value is ready. A browser tab has no native window buttons.
import { WorkspaceStore } from "./browser-storage.js";

const store = await WorkspaceStore.open({ channel: false });
const workspace = await store.snapshot();
store.close();

export default { workspace, controls: null };
