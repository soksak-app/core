#include <stdbool.h>

// 새 창의 첫 화면 표시.
//
// WebKit 은 화면에 올라간 창의 웹뷰만 그리고, 창이 화면에 올라간 뒤의 첫 그리기를 기다리지 않는다
// (WebViewImpl::windowDidOrderOnScreen 은 비동기 activity state 변경이다). 그래서 창을 보인 다음에 그린
// 페이지는 창이 열리는 동안 빈 창을 보인다. 이 함수는 창을 투명하게 화면에 올리도록 준비하고, 등록된 메인
// 웹뷰의 첫 문서 읽기가 끝나면(성공이든 실패든 loading 이 끝나면) 그 다음 표시가 끝난 뒤 창을 불투명하게
// 한다. 페이지는 첫 화면을 첫 await 전에 그리므로 그 표시가 첫 화면이다. 창을 화면에 올리는 일은 호출자가
// 이 함수 뒤에 한다.
//
// 메인 스레드에서 호출한다. 메인 웹뷰가 등록되지 않은 창이면 false 를 반환하고 error 에 호출자가 free()로
// 해제하는 오류 문자열을 쓴다. 성공하면 error 는 NULL 이다.
bool sp_window_reveal_after_load(void *window, char **error);
