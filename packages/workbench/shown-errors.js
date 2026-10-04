// 화면에 보인 오류를 애플리케이션 로그에 남긴다. 화면의 오류 표시는 다음 그리기나 reload 가 지우므로, 보인 순간의 기록이
// 그 오류의 유일한 흔적이다(docs/spec/hosts.md#application-log). 같은 자리에 같은 오류를 다시 그리면 다시 쓰지 않는다.
import { report } from "./host.js";

const shown = new Map();

/** where 에 text 오류를 보였다. 그 자리의 오류가 바뀌었을 때만 `error: <where>: <text>` 를 쓴다. */
export function reportShownError(where, text) {
  if (shown.get(where) === text) return;
  shown.set(where, text);
  report(`${where}: ${text}`);
}

/** where 의 오류 표시가 사라졌다. 다음에 같은 오류가 보이면 다시 쓴다. */
export function clearShownError(where) {
  shown.delete(where);
}
