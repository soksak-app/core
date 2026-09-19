#include <stdbool.h>

// 표면 위에 놓인 그림 영역. 외부에서 제공한 IOSurface 를 보여주고, 키보드·IME·접근성을
// 지원한다. 모든 함수는 메인 스레드에서 호출한다.

// 이벤트가 발생하면 호출된다. json 은 JSON 객체를 나타내고 호출이 끝나면 해제된다.
// 메인 스레드에서 호출된다.
typedef void (*sp_region_event)(void *context, const char *json);

// surface 웹뷰 위에 그림 영역을 만든다.
void *sp_region_create(void *surface, const char *name, sp_region_event event, void *context);

// 표면 뷰포트의 CSS 픽셀 여백(왼쪽, 위, 오른쪽, 아래)으로 영역을 정한다. 표면 크기가 바뀌면
// 여백을 유지한다.
void sp_region_place(void *region, double left, double top, double right, double bottom, bool visible);

// 적용된 영역의 장치 픽셀 너비·높이와 CSS 픽셀당 장치 픽셀 배율을 out[0..2]에 쓴다.
// 아직 배치되지 않았거나 크기와 배율을 얻을 수 없으면 false 다.
bool sp_region_raster(void *region, double *out);

// 외부 IOSurface 를 표시한다. token_id 는 IOSurface 의 전역 ID, nonce 는 논스 대조용
// 16바이트 데이터, width·height 는 장치 픽셀 단위의 크기고, scale 은 이미지가 만들어진
// 배율이다 (contentsScale 로 사용). 성공하면 true, 찾지 못했거나 크기가 맞지 않으면 false 를 반환한다.
bool sp_region_present(void *region, unsigned int token_id, const unsigned char *nonce, double width, double height, double scale);

// 첫 응답자로 만들고 포커스 이벤트를 보낸다. 이전 응답자에서 벗어나면 포커스 해제 이벤트도
// 보낸다.
void sp_region_focus(void *region);

// 캐럿(입력 커서) 위치를 받아 둔다. 캐럿 높이는 입력 메서드가 선택 창 위치를 정하는 데
// 쓴다.
void sp_region_caret(void *region, double x, double y, double w, double h);

// 접근성 값으로 보일 문자열을 받아 둔다.
void sp_region_text(void *region, const char *utf8);

// 창 좌표의 영역과 표시 여부, 포커스 상태 {x, y, width, height, visible, focused} 를
// out[0..5] 에 쓴다.
void sp_region_frame(void *region, double *out);

// 영역의 모든 정보를 JSON 으로 반환한다. 호출자가 malloc() 으로 할당된 문자열을 해제해야 한다.
const char *sp_region_facts(void *region);

// 영역을 제거하고 해제한다. 이후 event 는 호출되지 않는다.
void sp_region_close(void *region);
