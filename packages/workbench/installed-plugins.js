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
 * host 가 plugins-changed 를 보내면 상태를 다시 읽고 apply 로 변경을 이 창에 적용한다(docs/spec/installation.md#applying-a-change).
 * 읽기 실패는 상태의 error 로 보고되고, 적용의 실패는 문서의 unhandledrejection 으로 오류 표시에 간다.
 */
export function followPluginChanges(apply) {
  if (host) host.on("plugins-changed", async () => {
    await pluginOperations.refresh();
    await apply();
  });
}
