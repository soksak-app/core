// 문서의 UI 조작을 코어 명령으로 수행한다.
//
// 요소를 명령에 연결하는 방법은 플러그인 페이지와 같다(@soksak/plugin-api 의
// createBinder). 연결할 수 있는 명령은 등록소에 선언된 명령뿐이다.
import { createBinder } from "@soksak/plugin-api";
import { registry } from "./exposure.js";

export { commandOf, valueOf } from "@soksak/plugin-api";

/* 연결이 바뀌면 부를 함수. core.page.audit 의 감시가 등록한다. */
const listeners = new Set();

/**
 * 요소가 가리키는 명령을 실행한다. 플러그인 명령은 요소를 담은 가장 가까운 data-surface 의 표면이
 * 등록했으면 그 표면에서, 아니면 요청의 기본 선택 표면에서 실행한다. 사이드바 섹션의 조작이 이 경로를 쓴다.
 */
const runFrom = (name, params = {}, el) => {
  if (!registry.declared("command", name) || name.startsWith("core.")) return registry.run(name, params);
  // 기본값: 요소 없이 실행한 명령이나 표면 밖 요소의 명령은 원하는 표면이 없다(null).
  const wanted = el?.closest("[data-surface]")?.dataset.surface ?? null;
  // 기본값: 고를 표면이 없으면 표면을 지정하지 않고 실행해 레지스트리가 등록 순서로 고른다.
  return registry.run(name, params, registry.chosen("command", name, wanted) ?? undefined);
};

const binder = createBinder(runFrom, {
  check(name) {
    if (!registry.declared("command", name)) throw new Error(`command ${name} is not declared`);
  },
  changed: () => { for (const fn of listeners) fn(); },
});

/** 명령 하나를 실행한다. 실패는 호출자에게 거절로 돌아간다. */
export const run = (name, params = {}) => registry.run(name, params);
export const { audit, bind, delegate, mark } = binder;

/** 연결이 바뀌면 fn 을 호출한다. */
export function onBinding(fn) {
  listeners.add(fn);
}
