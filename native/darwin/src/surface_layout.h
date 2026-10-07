#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool surfaceLayoutCommit(void *owner, uint64_t ticket);
// 앱 DOM 웹뷰가 60fps 근처로 묶이지 않고 화면의 갱신 주기로 렌더링을 갱신하게 한다.
// WebKit 에 그 기능이 없으면 false 를 반환한다.
bool surfaceLayoutRenderAtDisplayRate(void *webview);
// 웹뷰가 60fps 근처의 렌더링 갱신을 선호하면 1, 아니면 0, 기능이 없으면 -1 을 반환한다.
int surfaceLayoutPrefersNear60FPS(void *webview);
void surfaceLayoutCancel(void *owner);
// 진단 전용. 배치 트랜잭션마다 시작, 앱 DOM 표시 확인, 커밋, 표시 확인 요청 시각(ms, 녹화 프레임과 같은 mach 시계)을
// 기록하기 시작한다. 이전 기록은 지운다.
void surfaceLayoutTraceStart(void);
// 한 트랜잭션 기록의 값 수: ticket, begun, presented, committed, requested.
#define SURFACE_LAYOUT_TRACE_STAGES 5
// 기록을 멈추고 트랜잭션마다 SURFACE_LAYOUT_TRACE_STAGES 개의 값을 out 에 최대 capacity 개 쓴다.
// 일어나지 않은 단계는 NaN 이다. 전체 트랜잭션 수를 반환한다. capacity 초과는 호출자가 오류로 처리한다.
size_t surfaceLayoutTraceStop(double *out, size_t capacity);
#ifdef __BLOCKS__
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int));
// 열린 배치를 커밋하기 전에 단일 앱 DOM의 표시 준비를 확인한다.
void surfaceLayoutAfterPresentation(void *mainWebview, void (^done)(void));
// 메인 문서의 창에 열린 표면 배치 트랜잭션이 없는 상태에서 단일 앱 DOM이 표시를 마치면
// done 을 메인 스레드에서 호출한다. displayed 는 그 표시가 화면에 나오는 시각(ms, mach 절대
// 시각)이다. 창이 화면에 없으면 호출 시각이다.
void surfaceLayoutAfterSettled(void *mainWebview, void (^done)(double displayed, const char *error));
// 다음 settled-presentation 요청에 실패를 주입한다. 진단 빌드 전용이다.
void surfaceLayoutInjectSettledFailure(void);
// 창 owner 의 새 페이지가 시작될 때 제목줄을 height(pt)로 정한다(docs/spec/native-surfaces.md#title-bar-height).
// 아직 보이지 않는 창은 이전 페이지를 보이지 않으므로 바로 정한다. 보이는 창은 새 페이지가 첫 그리기를 표시할 때까지
// 이전 페이지를 보이므로, ticket 으로 창의 배치 트랜잭션을 시작해 그 안에서 정하고, 등록된 메인 웹뷰의 읽기가 끝난 뒤
// 다음 표시 갱신에 그 트랜잭션을 커밋한다. 그 사이 같은 창의 새 준비가 트랜잭션을 이어받았으면 그 준비가 커밋한다.
// 높이를 정하면 ready(NULL) 을, 정하지 못하면 시작한 트랜잭션을 취소하고 ready(실패 문장) 을 메인 스레드에서 부른다.
// 다른 창의 트랜잭션이 열려 있으면 ready 는 그 트랜잭션이 끝난 뒤에 불린다. 메인 스레드에서 호출한다.
void surfaceLayoutStartPage(void *owner, uint64_t ticket, double height, void (^ready)(const char *failure));
#endif
