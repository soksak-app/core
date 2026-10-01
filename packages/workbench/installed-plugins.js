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

/** host 가 plugins-changed 를 보내면 상태를 다시 읽는다. 읽기 실패는 상태의 error 로 보고된다. */
export function followPluginChanges() {
  if (host) host.on("plugins-changed", () => pluginOperations.refresh());
}
