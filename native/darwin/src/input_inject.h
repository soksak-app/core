#include <stdbool.h>

// sp_input_pointer 의 결과.
typedef enum {
    SP_INPUT_DELIVERED = 0,
    SP_INPUT_REJECTED = 1, // 창, 좌표, 단계, 스레드가 올바르지 않다
    SP_INPUT_INACTIVE = 2, // 버튼 없는 이동이며 창이 키 창이 아니다. WebKit 은 이 이동으로 호버를 갱신하지 않는다
    SP_INPUT_UNRECEIVED = 3, // 누름이나 뗌을 문서가 제한 시간 안에 받지 않았거나, 스크롤 대상이 제한 시간 안에 표시하지 않았다
} sp_input_result;

// 창에 네이티브 입력을 전달한다. 좌표는 콘텐츠 영역 왼쪽 위 기준 포인트 값이다.
//
// phase: 0 이동, 1 누름, 2 끌기, 3 뗌, 4 스크롤. button: 0 왼쪽, 1 오른쪽.
sp_input_result sp_input_pointer(void *window, double x, double y, int phase, int button, double deltaX, double deltaY);

typedef void (*sp_input_done)(void *context, sp_input_result result);

// sp_input_pointer 와 같고, 누름과 뗌은 좌표의 문서가 그 이벤트를 받은 뒤 done 을 호출한다.
// WebKit 은 입력 칸에 초점이 있으면 마우스 이벤트를 입력기에 먼저 비동기로 넘기므로, 곧바로 이어서
// 전달한 누름과 뗌의 순서가 문서에서 바뀔 수 있다. 스크롤은 좌표의 웹뷰가 현재 상태를 표시한 뒤
// 전달한다. 새 문서의 스크롤 트리가 표시되기 전에 받은 휠 이벤트는 문서를 움직이지 않는다.
// timeoutSeconds 안에 수신이나 표시가 없으면 SP_INPUT_UNRECEIVED 다. done 은 메인 스레드에서 한 번
// 호출된다. 메인 스레드에서 호출한다.
void sp_input_pointer_then(void *window, double x, double y, int phase, int button, double deltaX, double deltaY,
    double timeoutSeconds, sp_input_done done, void *context);

// sp_input_activate 의 결과. 실패는 활성화가 멈춘 단계를 나타낸다.
typedef enum {
    SP_ACTIVATE_DONE = 0,
    SP_ACTIVATE_REJECTED = 1, // 창이 없거나 메인 스레드가 아니다
    SP_ACTIVATE_REFUSED = 2,  // 제한 시간 안에 애플리케이션이 활성화되지 않았다
    SP_ACTIVATE_NOT_KEY = 3,  // 애플리케이션은 활성이지만 제한 시간 안에 창이 키 창이 되지 않았다
    SP_ACTIVATE_PENDING = 4,  // 창의 웹뷰가 제한 시간 안에 활성 상태를 웹 프로세스에 보내지 않았다
    SP_ACTIVATE_LOST = 5,     // 웹뷰가 활성 상태를 보낸 뒤에는 앱이 비활성이거나 창이 키 창이 아니다
} sp_activate_result;

// frontmost 는 결과가 SP_ACTIVATE_DONE 이 아닐 때 그 시점의 최전면 애플리케이션 이름이다(번들
// 식별자, 없으면 표시 이름, 모르면 NULL). done 이 반환할 때까지만 유효하다.
typedef void (*sp_activate_done)(void *context, sp_activate_result result, const char *frontmost);

// 애플리케이션을 활성화하고 창을 키 창으로 만든다. 창이 키 창이 되고 창 안의 모든 웹뷰가 활성
// 상태를 웹 프로세스에 보낸 뒤 done 을 SP_ACTIVATE_DONE 으로 호출한다. 이 과정이 timeoutSeconds
// 안에 끝나지 않으면 멈춘 단계를 결과로 호출한다. done 은 메인 스레드에서 한 번만 호출된다.
// 메인 스레드에서 호출한다.
void sp_input_activate(void *window, double timeoutSeconds, sp_activate_done done, void *context);

// key 는 키 이름(Enter, Tab, Escape, Backspace, ArrowLeft 등) 또는 문자 하나다. text 는 입력할
// 문자열이며 NULL 이면 key 를 사용한다. modifiers 는 비트 합: 1 Shift, 2 Control, 4 Option,
// 8 Command. down 이 참이면 누름, 거짓이면 뗌이다.
bool sp_input_key(void *window, const char *key, const char *text, unsigned modifiers, bool down);
