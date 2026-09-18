#include <stdbool.h>

// Wails 의 cgo 코드에도 windowFullscreen 이 있어 이름이 겹치면 링커가 하나를 고른다. 공개 이름은
// sp_ 로 시작한다.
//
// 창을 전체 화면으로 바꾸거나 되돌리고, 전환이 끝나면 done 을 메인 스레드에서 호출한다.
//
// macOS 는 전환이 진행 중인 동안 새 요청을 무시하므로, 진행 중이면 끝난 뒤에 이어서 바꾼다.
// 이미 원하는 상태이면 done 을 바로 호출한다. 창이 전체 화면을 지원하지 않으면 false 를 반환한다.
#ifdef __BLOCKS__
bool sp_window_fullscreen(void *window, bool on, void (^done)(void));
#endif
