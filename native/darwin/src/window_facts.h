#include <stdbool.h>

// 창과 화면의 상태를 JSON 문자열로 반환한다. 반환한 문자열은 sp_facts_free 로 해제한다.
// 모든 함수는 메인 스레드에서 호출한다. 화면 좌표는 주 디스플레이 왼쪽 위 기준이고 y 가
// 아래로 증가하는 포인트 값이며, 창 좌표는 콘텐츠 영역 왼쪽 위 기준이다.

// 창의 앱 DOM 웹뷰를 명시적으로 등록한다. 그리기 순서로 메인 뷰를 추측하지 않는다.
// 웹뷰가 창에 부착되지 않았거나 다른 메인이 이미 등록되었으면 false다.
bool sp_window_set_main_webview(void *window, void *main);

// 등록된 앱 DOM 웹뷰만 반환한다. 등록되지 않은 창은 NULL 이다.
void *sp_window_main_webview(void *window);

// {frame, content, scale, key, active, children, controls, webviews, nativeSurfaces, appDomWebviews, documentWebviews}
//   frame     창 프레임 {x, y, width, height}, 화면 좌표
//   content   콘텐츠 영역 {width, height}
//   controls  창 단추 [{x, y, width, height, hidden}], 창 좌표
//   webviews  창 안의 WKWebView 를 그리기 순서로 나열한다(메인 위치를 가정하지 않는다)
//             [{view, x, y, width, height, hidden, focused, draws, alpha}], 창 좌표.
//             view 는 뷰 주소, draws 는 자기 배경을 칠하는지, alpha 는 페이지 아래 배경색의 알파다
//   nativeSurfaces 논리 표면 컨테이너 [{view, x, y, width, height, hidden}], 창 좌표.
// 창이나 등록된 메인 웹뷰가 없으면 NULL 을 반환한다.
char *sp_window_facts(void *window);

// 창 좌표 (x, y) 의 히트 테스트 결과 {view, main, identifier}. view 는 점을 포함한 WKWebView 의
// 주소이며 없으면 0 이다. main 은 그 웹뷰가 메인 페이지인지다. identifier 는 히트한 뷰의 identifier 다. 창이 없으면 NULL 이다.
char *sp_window_hit(void *window, double x, double y);

// 디스플레이 [{x, y, width, height, scale}], 화면 좌표.
char *sp_screens(void);

// 창 프레임의 왼쪽 위를 화면 좌표 (x, y) 로 옮긴다.
bool sp_window_move(void *window, double x, double y);

// 애플리케이션 메뉴(JSON 배열). 하위 메뉴마다 {title, items: [{title, key}]} 이며 구분선은 뺀다.
// key 는 단축키로, 수정 키를 ctrl, opt, shift, cmd 순서로 + 로 이어 붙인 뒤 키 문자를 붙인다.
char *sp_menu_items(void);

// Dock 메뉴 항목의 제목 목록(JSON 배열).
char *sp_dock_items(void);

// 제목이 title 인 Dock 메뉴 항목을 실행한다. 항목이 없으면 false 다.
bool sp_dock_select(const char *title);

void sp_facts_free(char *text);
