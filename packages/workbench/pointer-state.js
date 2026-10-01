// 메인 문서가 받은 마지막 pointer 순서. 누름과 뗌 사이에 누른 요소가 교체되면 브라우저는 click 을 만들지 않으므로,
// 사라진 click 을 가릴 수 있도록 누름, 뗌, click 의 대상 이름과 뗄 때 누른 요소가 문서에 남아 있었는지 기록한다.
import { focusName } from "./focus-state.js";

/**
 * document 의 pointerdown, pointerup, click 을 기록하고 바뀔 때마다 changed 를 부른다. 반환값은 현재 기록을 돌려주는
 * 함수이며, 기록은 { sequence, down, up, pressedConnected, click } 이다. 누름마다 sequence 가 늘고 나머지가 새로 시작한다.
 */
export function trackPointer(document, changed) {
  let sequence = 0;
  let pressed = null;
  let record = { sequence, down: null, up: null, pressedConnected: null, click: null };
  document.addEventListener("pointerdown", (event) => {
    sequence++;
    pressed = event.composedPath()[0];
    record = { sequence, down: focusName(event), up: null, pressedConnected: null, click: null };
    changed();
  }, true);
  document.addEventListener("pointerup", (event) => {
    record = { ...record, up: focusName(event), pressedConnected: pressed ? pressed.isConnected : null };
    changed();
  }, true);
  document.addEventListener("click", (event) => {
    record = { ...record, click: focusName(event) };
    changed();
  }, true);
  return () => record;
}
