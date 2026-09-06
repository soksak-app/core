// 이 페이지를 실행하는 런타임을 선택한다.
//
// 호출 방식, 이벤트 수신 방식, 자체 문서 주소가 런타임마다 다르다. 그 차이를 이
// 디렉터리에 모으고 나머지 코드는 런타임을 구분하지 않는다.
import * as tauriv2 from "./tauriv2.js";
import * as wailsv3 from "./wailsv3.js";
import * as webview from "./webview.js";

/** present() 가 true 를 반환하는 첫 항목을 선택한다. */
const FRAMEWORKS = [tauriv2, wailsv3, webview];

/* 표면·모달 페이지도 같은 애플리케이션의 문서이므로 같은 방법으로 판별된다. */
const chosen = FRAMEWORKS.find((f) => f.present());

if (!chosen) throw new Error("unknown framework");

/** 선택된 런타임의 이름. */
export const framework = chosen.name;

/**
 * 메인 페이지에서 호스트를 호출하는 인터페이스. 호스트가 없으면 null.
 *
 *   call(name, arg)  호스트 함수를 호출한다
 *   on(event, fn)    호스트 이벤트를 수신한다. fn 은 payload 만 받는다
 *   page(path)       호스트가 서비스하는 문서의 URL 을 반환한다
 */
export const host = chosen.host();

/**
 * 표면·모달 페이지에서 호스트를 호출하는 인터페이스. 없으면 null.
 *
 *   theme(fn)                현재 테마와 변경 시의 테마를 fn 에 전달한다
 *   shell.open(id)           해당 표면의 셸을 연다
 *   shell.write(id, text)    셸에 입력을 전달한다
 *   shell.onOutput(id, fn)   셸 출력을 수신한다
 *   modal.content(id, fn)    렌더링할 내용과 변경분을 fn 에 전달한다
 *   modal.ready(id)          내용이 화면에 올랐음을 호스트에 알린다
 *   modal.answer(id, k, v)   변경한 키와 값을 호스트에 보고한다
 */
export const page = chosen.page();
