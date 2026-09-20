#include <stdbool.h>
#include <stdint.h>

bool surfaceLayoutCommit(void *owner, uint64_t ticket);
void surfaceLayoutCancel(void *owner);
#ifdef __BLOCKS__
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int));
// 메인 문서의 창에 열린 표면 배치 트랜잭션이 없는 상태에서 메인 문서와 보이는 앱 문서가 표시를 마치면
// done 을 메인 스레드에서 호출한다. displayed 는 그 표시가 화면에 나오는 시각(ms, mach 절대
// 시각)이다. 창이 화면에 없으면 호출 시각이다.
void surfaceLayoutAfterSettled(void *mainWebview, void (^done)(double displayed));
#endif
