#include <stdint.h>

// 호출 스레드와 관계없이 다음 메인 큐 실행에서 callback 을 한 번 호출한다.
void sp_ui_enqueue(void (*callback)(uintptr_t), uintptr_t context);
