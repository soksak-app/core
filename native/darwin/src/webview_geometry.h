#include <stddef.h>
#include <stdbool.h>

// 앱 DOM은 창에 하나만 두며 논리 표면은 웹뷰 없는 클리핑 컨테이너다.
void *sp_surface_create(void *mainWebview);
// 창에 놓인 파일을 받는다. event 는 {"urls":[파일 URL...],"x":..,"y":..}(페이지 좌표) 를 받는다.
// release 가 NULL 이 아니면 놓기 뷰가 context 를 더 쓰지 않게 될 때(다음 등록이 수신기를 바꾸거나 창과 함께 뷰가
// 해제될 때) 메인 스레드에서 한 번 호출된다. false 를 반환하면 release 를 호출하지 않으며 context 는 호출자의 것이다.
typedef void (*sp_file_drop_event)(void *context, const char *json);
typedef void (*sp_file_drop_release)(void *context);
bool sp_window_file_drop(void *mainWebview, sp_file_drop_event event, sp_file_drop_release release, void *context);
void sp_surface_close(void *surface);
void *sp_surface_native_plane(void *surface);
void *sp_surface_main_webview(void *surface);
double sp_surface_scale(void *surface);
// 앱 DOM 모달/메뉴가 네이티브 입력보다 우선하는 창 좌표 사각형(x,y,w,h).
void sp_surface_set_window_overlays(void *mainWebview, const double *rects, size_t count);

void webviewAttachSurface(void *webview, void *mainWebview);
void webviewDetachSurface(void *webview);
// 표면의 네이티브 평면. 영역은 이 뷰의 하위에만 둘 수 있다.
void *webviewSurfaceNativePlane(void *surface);
#ifdef __OBJC__
@class NSEvent, NSView;
// 표면 좌표계 안의 뷰는 좌표 한 단위가 장치 픽셀 하나다. WebKit 은 휠 이동량(포인트)을 뷰 좌표
// 단위로 쓰므로, view 로 가는 휠 이벤트를 그 단위로 바꾼 이벤트를 반환한다. 표면 좌표계 밖이면 event 다.
NSEvent *webviewScrollInViewUnits(NSEvent *event, NSView *view);
#endif
// 표면 웹뷰 안에 둔 웹뷰가 표면과 같은 단위로 그리게 한다.
void webviewMatchSurface(void *webview, void *surface);
void webviewSetFrame(void *webview, double x, double y, double width, double height);
void webviewGetFrame(void *webview, double *rect);
void webviewSetSurfaceHidden(void *webview, bool hidden);
void webviewSetSurfaceAlpha(void *webview, double alpha);
// 현재 WebContent 프로세스를 종료한다. 애플리케이션 종료가 WebKit 자식 프로세스를 남기지 않으려고 부른다.
bool sp_webview_kill_content_process(void *webview);
// 진단 build 의 측정용: webview 의 process pool 에 있는 WebContent process 들이 JavaScript 객체의 쓰레기 수집을 하게 한다.
// WebKit 은 바뀐 이전 페이지를 나중의 수집에서 지우므로, 메모리 검사는 다시 읽은 뒤 이것으로 수집하고 잰다.
// 시험용 수집이 없으면 false 다.
bool sp_webview_collect_garbage(void *webview);
// 선언된 DOM 오버레이의 CSS 픽셀 여백과 표시 여부를 설정한다. values 는 항목마다
// left, top, right, bottom, visible 순서의 다섯 값이다.
void webviewSetSurfaceOverlays(void *webview, const double *values, size_t count);
