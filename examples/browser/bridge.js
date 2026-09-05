// 호스트로 가는 다리.
//
// 브라우저에는 호스트가 없다. 앱은 이 파일을 자기 것으로 덮어쓴다.
//
// 다리가 내놓는 것은 넷이다:
//   ready(fn)          다리가 준비되면 부른다
//   call(name, arg)    호스트에게 시킨다. 이름은 여기 목록의 것이다
//   on(event, fn)      호스트가 말하는 것을 듣는다. fn 은 실린 것만 받는다
//   page(path)         이 호스트가 서비스하는 문서의 주소
//
// 이름: syncSurfaces · setTheme · report · overlayShow · overlayUpdate ·
//       overlayHide
// 사건: surface-pressed · overlay-pick

const bridge = null;
