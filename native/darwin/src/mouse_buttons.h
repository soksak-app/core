#include <stdbool.h>

// AppKit 이 보고하는 눌린 마우스 버튼 mask(+[NSEvent pressedMouseButtons]: bit 0 왼쪽, bit 1 오른쪽, 그 위 bit 는
// 다른 버튼)를 알린다. 메인 스레드에서 호출된다.
typedef void (*sp_mouse_buttons_changed)(void *context, unsigned long long mask);

// 마우스 버튼 감시를 설치한다. 설치한 차례에 현재 mask 를 한 번 알리고, 그 뒤 AppKit 이 이 애플리케이션(로컬
// 이벤트 감시)이나 다른 애플리케이션(전역 이벤트 감시)에 마우스 버튼의 누름이나 뗌을 전달할 때마다 그 차례의
// mask 를 알린다. 같은 mask 도 다시 알리므로 변경 판정은 받는 쪽이 한다. 합성 입력(input_inject.h)은 AppKit 의
// 이벤트 전달을 거치지 않고 뷰로 가므로 알리지 않는다. 감시는 프로세스가 끝날 때까지 유지된다.
//
// 메인 스레드에서 한 번 호출한다. 메인 스레드가 아니거나, 이미 설치했거나, AppKit 이 감시를 만들지 않으면
// false 를 반환하고 알리지 않는다.
bool sp_mouse_buttons_watch(sp_mouse_buttons_changed changed, void *context);
