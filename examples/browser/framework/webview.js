// 그냥 웹뷰 — 담고 있는 것이 없다.
//
// 브라우저에서 이 페이지를 열면 여기다. 호스트가 없으므로 표면은 페이지가
// 스스로 그리고, 표면과 모달의 페이지는 열리지 않는다.

export const name = "webview";

/** 아무것도 요구하지 않으므로 언제나 있다. 목록의 마지막이다. */
export const present = () => true;

export const host = () => null;
export const page = () => null;
