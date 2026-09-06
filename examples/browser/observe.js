// 페이지 쪽 관측.
//
// 호스트의 관측 부품이 CSS 선택자를 보내면 그 요소에 클릭 이벤트를 전달한다. 사용자가
// 누를 때와 같은 이벤트이므로 제품이 사용하는 경로를 측정한다. 경계는 표면 위에 있어
// 호스트가 좌표로 전달할 수 있지만, 카드 밖의 버튼은 이 문서의 DOM 요소이므로 문서만
// 클릭을 전달할 수 있다.
//
// 호스트가 요청하지 않으면 실행되지 않는다.
import { host } from "./framework/index.js";

if (host) {
  host.on("observe-click", (selector) => {
    const el = document.querySelector(selector);
    if (!el) {
      host.call("report", `관측: ${selector} 를 찾지 못했다`);
      return;
    }
    el.click();
    host.call("report", `관측: ${selector} 를 눌렀다`);
  });
}
