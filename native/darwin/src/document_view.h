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

// A message of a plugin document: the JSON object {"message": <value>} for each message that the document posts to
// its own window, or {"error": <reason>} when its data is not JSON or a post of the page fails. json is released when
// the call returns. Called on the main thread.
typedef void (*sp_document_message)(void *context, const char *json);

// surface 웹뷰 안에 숨긴 문서 웹뷰를 만든다. directory 는 영구 데이터 저장소가 사이트 데이터를 두는
// 절대 경로로, 없으면 만든다. 같은 디렉터리의 문서는 같은 저장소를 쓴다. folder and plugin name the installed
// folder and the id of the plugin whose surface owns the region; sok://<plugin>/<path> serves <path> from that folder,
// and NULL folder serves nothing. 만들 수 없으면 NULL 을 반환한다.
void *sp_document_create(void *surface, const char *directory, const char *folder, const char *plugin,
    sp_document_changed changed, void *context);

// Sets the receiver of the messages of plugin documents. NULL reports none. The caller keeps context while the
// document lives.
void sp_document_set_message(void *document, sp_document_message message, void *context);

// Posts the JSON value json to the window of the current plugin document of the region's plugin. Returns false and
// posts nothing when the current document is not such a document or json is not JSON.
bool sp_document_post(void *document, const char *json);

// 문서의 네이티브 이벤트 수신기를 설정한다. event 가 NULL 이면 이벤트를 보고하지 않는다.
// 호출자는 문서가 살아 있는 동안 context 를 유지해야 한다.
void sp_document_set_event(void *document, sp_document_event event, void *context);

// Opens an http, https, file or sok address. Refuses another address and returns false.
bool sp_document_load(void *document, const char *url);

// action: 0 뒤로, 1 앞으로, 2 다시 읽기, 3 멈춤, 4 현재 항목에서 offset 만큼 떨어진 세션 기록 항목.
// offset 은 4 에서만 쓰며 0 이거나 기록 밖이면 false 를 반환한다.
bool sp_document_go(void *document, int action, int offset);

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

// 문서 webview 와 그 웹 콘텐츠가 사용하는 네이티브 appearance 를 설정한다.
void sp_document_appearance(void *document, bool dark);

// 웹뷰를 제거하고 해제한다. 이후 changed 는 호출되지 않는다.
void sp_document_close(void *document);
