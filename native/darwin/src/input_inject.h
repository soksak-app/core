#include <stdbool.h>

// 창에 네이티브 입력을 전달한다. 좌표는 콘텐츠 영역 왼쪽 위 기준 포인트 값이다.
//
// phase: 0 이동, 1 누름, 2 끌기, 3 뗌, 4 스크롤. button: 0 왼쪽, 1 오른쪽.
bool sp_input_pointer(void *window, double x, double y, int phase, int button, double deltaX, double deltaY);

// key 는 키 이름(Enter, Tab, Escape, Backspace, ArrowLeft 등) 또는 문자 하나다. text 는 입력할
// 문자열이며 NULL 이면 key 를 사용한다. modifiers 는 비트 합: 1 Shift, 2 Control, 4 Option,
// 8 Command. down 이 참이면 누름, 거짓이면 뗌이다.
bool sp_input_key(void *window, const char *key, const char *text, unsigned modifiers, bool down);
