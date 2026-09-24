#include <stdbool.h>
#include <stdint.h>

bool surfaceLayoutCommit(void *owner, uint64_t ticket);
// 앱 DOM 웹뷰가 60fps 근처로 묶이지 않고 화면의 갱신 주기로 렌더링을 갱신하게 한다.
// WebKit 에 그 기능이 없으면 false 를 반환한다.
bool surfaceLayoutRenderAtDisplayRate(void *webview);
// 웹뷰가 60fps 근처의 렌더링 갱신을 선호하면 1, 아니면 0, 기능이 없으면 -1 을 반환한다.
int surfaceLayoutPrefersNear60FPS(void *webview);
void surfaceLayoutCancel(void *owner);
#ifdef __BLOCKS__
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int));
// 열린 배치를 커밋하기 전에 단일 앱 DOM의 표시 준비를 확인한다.
void surfaceLayoutAfterPresentation(void *mainWebview, void (^done)(void));
// 메인 문서의 창에 열린 표면 배치 트랜잭션이 없는 상태에서 단일 앱 DOM이 표시를 마치면
// done 을 메인 스레드에서 호출한다. displayed 는 그 표시가 화면에 나오는 시각(ms, mach 절대
// 시각)이다. 창이 화면에 없으면 호출 시각이다.
void surfaceLayoutAfterSettled(void *mainWebview, void (^done)(double displayed, const char *error));
// Diagnostics-only failure injection for the next settled-presentation request.
void surfaceLayoutInjectSettledFailure(void);
#endif
