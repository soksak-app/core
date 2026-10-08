// 이 창의 플러그인 작업 상태 하나(plugin-operations.js). core.plugins status 와 설정 창의 플러그인 절이 함께 쓴다.
import { host } from "@soksak/runtime";
import { pluginUnits } from "./environment.js";
import { createPluginOperations } from "./plugin-operations.js";

const listeners = new Set();

export const pluginOperations = createPluginOperations({
  host, loaded: pluginUnits, changed: () => { for (const fn of listeners) fn(); },
});

/** 플러그인 작업 상태가 바뀔 때마다 fn 을 부른다. */
export function onPluginOperations(fn) {
  listeners.add(fn);
}

/**
 * On plugins-changed from the host, reads the state again and applies the change to this window with apply
 * (docs/spec/installation.md#applying-a-change). A read failure is reported as the error of the state, and a failure
 * of apply reaches the error display through the document's unhandledrejection.
 */
export function followPluginChanges(apply) {
  if (host) host.on("plugins-changed", async () => {
    await pluginOperations.refresh();
    await pluginOperations.refreshOutdated();
    await apply();
  });
}

/** On sidecars-changed from the host, reads the outdated sidecars again (docs/spec/installation.md). */
export function followSidecarChanges() {
  if (host) host.on("sidecars-changed", () => pluginOperations.refreshOutdated());
}
