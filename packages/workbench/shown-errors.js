// 사용자에게 오류를 보이는 유일한 경로. 화면의 오류 표시는 다음 그리기나 reload 가 지우므로, 보이는 순간 애플리케이션
// 로그에 남긴 기록이 그 오류의 흔적이다(AGENTS.md, docs/spec/hosts.md#application-log). 오류 색은 이 경로가 붙이는
// `data-error` 요소에만 쓴다. 같은 자리에 같은 오류를 다시 그리면 다시 쓰지 않는다.
import { report } from "./host.js";

const shown = new Map();

/**
 * 요소 element 에 where 자리의 오류 text 를 보이고, 그 자리의 오류가 바뀌었을 때만 `error: <where>: <text><detail>` 를 쓴다.
 * detail 은 화면에는 보이지 않고 로그에만 남는 세부(오류의 위치나 stack)다.
 */
export function showError(element, where, text, detail = "") {
  element.textContent = text;
  element.dataset.error = where;
  element.hidden = false;
  if (shown.get(where) === text) return;
  shown.set(where, text);
  report(`${where}: ${text}${detail}`);
}

/** where 자리의 오류 표시를 거둔다. 요소 없이 그려지지 않은 자리도 거둘 수 있다. 다음에 같은 오류가 보이면 다시 쓴다. */
export function hideError(element, where) {
  if (element) delete element.dataset.error;
  shown.delete(where);
}
