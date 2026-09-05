// 지금 이 페이지를 담고 있는 것이 무엇인지 고른다.
//
// 프레임워크마다 호출하는 법도, 듣는 법도, 자기 문서를 가리키는 법도 다르다.
// 그 차이는 여기 한 곳에 있고, 나머지 코드는 어느 프레임워크인지 알지 못한다.
//
// 고르는 것이지 짐작하는 것이 아니다 — 런타임은 자기가 있다고 스스로 말한다.
import * as tauriv2 from "./tauriv2.js";
import * as wailsv3 from "./wailsv3.js";
import * as webview from "./webview.js";

/** 먼저 있다고 말하는 것을 쓴다. 아무것도 없으면 그냥 웹뷰다. */
const FRAMEWORKS = [tauriv2, wailsv3, webview];

/* 호스트가 만든 페이지(표면·모달)는 주 페이지와 다른 곳에서 실린다. Wails 의
   경우 주 페이지는 wails:// 이고 표면은 앱이 띄운 루프백 서버다 — 그 주소만
   보고는 어느 프레임워크인지 알 수 없다. 그래서 호스트가 자기 페이지를 열 때
   자기 이름을 실어 보낸다. */
const declared = new URLSearchParams(location.search).get("framework");

const chosen = declared
  ? FRAMEWORKS.find((f) => f.name === declared)
  : FRAMEWORKS.find((f) => f.present());

if (!chosen) throw new Error(`unknown framework: ${declared}`);

/** 이 페이지를 담고 있는 것의 이름. 로그가 이것을 적는다. */
export const framework = chosen.name;

/**
 * 주 페이지에서 호스트로 가는 다리. 호스트가 없으면 null 이다.
 *
 *   ready(fn)        다리가 준비되면 부른다
 *   call(name, arg)  호스트에게 시킨다
 *   on(event, fn)    호스트가 말하는 것을 듣는다. fn 은 실린 것만 받는다
 *   page(path)       이 호스트가 서비스하는 문서의 주소
 */
export const host = chosen.host();

/**
 * 호스트가 만든 페이지(표면·모달)에서 호스트로 가는 다리. 없으면 null 이다.
 *
 *   theme(fn)                지금 테마와, 바뀔 때마다
 *   shell.open(id)           그 표면의 셸을 연다
 *   shell.write(id, text)    한 줄 보낸다
 *   shell.onOutput(id, fn)   셸이 낸 것을 듣는다
 *   modal.content(id, fn)    그릴 내용과, 바뀔 때마다
 *   modal.fit(id, w, h)      필요한 크기를 알린다
 *   modal.answer(id, k, v)   무엇을 무엇으로 했는지 돌려준다
 */
export const page = chosen.page();
