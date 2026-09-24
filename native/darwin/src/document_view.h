#include <stdbool.h>

// 표면 문서 안의 한 영역에 외부 문서를 표시하는 웹뷰.
//
// 문서 웹뷰는 표면 웹뷰의 하위 뷰이므로 표면과 함께 옮겨지고, 숨겨지고, 닫힌다. 앱의 브리지,
// 주입 스크립트, 데이터 저장소를 공유하지 않는다. 모든 함수는 메인 스레드에서 호출한다.

// 문서 상태가 바뀌면 호출된다. state 는 JSON 객체
//   {url, title, loading, progress, canGoBack, canGoForward, error, scroll: {x, y}}
// 이며 호출이 끝나면 해제된다. 메인 스레드에서 호출된다.
typedef void (*sp_document_changed)(void *context, const char *state);

// 네이티브 문서 입력 이벤트가 발생하면 호출된다. json 은 JSON 객체를 나타내며 호출이 끝나면
// 해제된다. 메인 스레드에서 호출된다.
typedef void (*sp_document_event)(void *context, const char *json);

// surface 웹뷰 안에 숨긴 문서 웹뷰를 만든다. store 는 영구 데이터 저장소의 이름으로, 같은 이름은
// 같은 저장소를 쓴다. 만들 수 없으면 NULL 을 반환한다.
void *sp_document_create(void *surface, const char *store, sp_document_changed changed, void *context);

// 문서의 네이티브 이벤트 수신기를 설정한다. event 가 NULL 이면 이벤트를 보고하지 않는다.
// 호출자는 문서가 살아 있는 동안 context 를 유지해야 한다.
void sp_document_set_event(void *document, sp_document_event event, void *context);

// http 또는 https 주소를 연다. 그 밖의 주소는 거부하고 false 를 반환한다.
bool sp_document_load(void *document, const char *url);

// action: 0 뒤로, 1 앞으로, 2 다시 읽기, 3 멈춤.
bool sp_document_go(void *document, int action);

// 표면 뷰포트의 CSS 픽셀 여백(왼쪽, 위, 오른쪽, 아래)으로 영역을 정한다. 표면 크기가 바뀌면
// 여백을 유지한다.
void sp_document_place(void *document, double left, double top, double right, double bottom, bool visible);

// 창 좌표의 영역과 표시 여부 {x, y, width, height, visible} 를 out[0..4] 에 쓴다.
void sp_document_frame(void *document, double *out);

// 문서의 페이지 확대를 글자 배율 zoom 으로 정한다(docs/spec/text-size.md). 배치와 표면 배율이 바뀌어도
// 유지한다. 유한한 양수가 아니면 false 를 반환하고 바꾸지 않는다.
bool sp_document_zoom(void *document, double zoom);

// 대화 상자가 열린 동안 문서를 흐리게 표시한다.
void sp_document_background(void *document, bool enabled);

// Sets the native appearance used by the document webview and its web content.
void sp_document_appearance(void *document, bool dark);

// 웹뷰를 제거하고 해제한다. 이후 changed 는 호출되지 않는다.
void sp_document_close(void *document);
