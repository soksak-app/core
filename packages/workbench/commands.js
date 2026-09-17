// 문서의 UI 조작을 코어 명령으로 수행한다.
//
// 요소를 명령에 연결하는 방법은 플러그인 페이지와 같다(@soksak/plugin-api 의
// createBinder). 연결할 수 있는 명령은 등록소에 선언된 명령뿐이다.
import { createBinder } from "@soksak/plugin-api";
import { registry } from "./exposure.js";

export { commandOf, valueOf } from "@soksak/plugin-api";

/* 연결이 바뀌면 부를 함수. core.page.audit 의 감시가 등록한다. */
const listeners = new Set();

const binder = createBinder((name, params = {}) => registry.run(name, params), {
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
