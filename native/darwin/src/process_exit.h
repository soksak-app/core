#include <stdbool.h>
#include <sys/types.h>

typedef void (*sp_process_exit_done)(void *context, bool exited);

// pid 의 프로세스가 끝나면 exited true 를, seconds 안에 끝나지 않으면 exited false 를 done 에 준다. 이미 없는
// 프로세스는 끝난 것이다. 커널의 프로세스 종료 알림(kqueue NOTE_EXIT)으로 기다린다. 메인 스레드에서 호출하고
// done 은 메인 스레드에서 한 번 호출된다.
void sp_process_when_exited(pid_t pid, double seconds, sp_process_exit_done done, void *context);
