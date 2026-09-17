#include <stdbool.h>

// sp_input_pointer 의 결과.
typedef enum {
    SP_INPUT_DELIVERED = 0,
    SP_INPUT_REJECTED = 1, // 창, 좌표, 단계, 스레드가 올바르지 않다
    SP_INPUT_INACTIVE = 2, // 버튼 없는 이동이며 창이 키 창이 아니다. WebKit 은 이 이동으로 호버를 갱신하지 않는다
} sp_input_result;

// 창에 네이티브 입력을 전달한다. 좌표는 콘텐츠 영역 왼쪽 위 기준 포인트 값이다.
//
// phase: 0 이동, 1 누름, 2 끌기, 3 뗌, 4 스크롤. button: 0 왼쪽, 1 오른쪽.
sp_input_result sp_input_pointer(void *window, double x, double y, int phase, int button, double deltaX, double deltaY);

// 애플리케이션을 활성화하고 창을 키 창으로 만든다. 창이 키 창이 되고 창 안의 모든 웹뷰가 활성
// 상태를 웹 프로세스에 보낸 뒤 done(context, true) 를 메인 스레드에서 호출한다. 시스템이
// timeoutSeconds 안에 활성화하지 않으면 done(context, false) 를 호출한다. 메인 스레드에서 호출한다.
void sp_input_activate(void *window, double timeoutSeconds, void (*done)(void *context, bool ok), void *context);

// key 는 키 이름(Enter, Tab, Escape, Backspace, ArrowLeft 등) 또는 문자 하나다. text 는 입력할
// 문자열이며 NULL 이면 key 를 사용한다. modifiers 는 비트 합: 1 Shift, 2 Control, 4 Option,
// 8 Command. down 이 참이면 누름, 거짓이면 뗌이다.
bool sp_input_key(void *window, const char *key, const char *text, unsigned modifiers, bool down);
