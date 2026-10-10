// Browser runtime. There is no native host.
//
// The page draws the surface areas itself, and surface pages and modal pages are not opened. Settings and
// the project list are stored in IndexedDB.
import { WorkspaceStore } from "./browser-storage.js";
import { createClipboardBridge } from "@soksak/plugin-api";

export const host = null;
export const page = null;
export const clipboard = createClipboardBridge(async (_name, { type }) => {
  if (type !== "text" || !globalThis.navigator?.clipboard?.readText) return { present: false, type };
  try {
    return { present: true, type: "text", text: await navigator.clipboard.readText() };
  } catch (error) {
    throw error;
  }
});

export const openStore = () => WorkspaceStore.open();
export { windows } from "./windows.js";
