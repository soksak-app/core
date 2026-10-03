#import <Foundation/Foundation.h>
#import <errno.h>
#import <signal.h>
#import "process_exit.h"

void sp_process_when_exited(pid_t pid, double seconds, sp_process_exit_done done, void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_process_when_exited requires the main thread");
    dispatch_queue_t main = dispatch_get_main_queue();
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid, DISPATCH_PROC_EXIT, main);
    __block bool answered = false;
    void (^answer)(bool) = ^(bool exited) {
        if (answered) return;
        answered = true;
        dispatch_source_cancel(source);
        done(context, exited);
    };
    dispatch_source_set_event_handler(source, ^{ answer(true); });
    dispatch_source_set_cancel_handler(source, ^{ dispatch_release(source); });
    dispatch_resume(source);
    // 등록 전에 끝난 프로세스는 알림을 내지 않는다. 등록한 뒤 프로세스가 없으면 끝난 것이다. 다른 사용자의 프로세스는
    // EPERM 이고 살아 있다.
    if (kill(pid, 0) != 0 && errno == ESRCH) {
        dispatch_async(main, ^{ answer(true); });
        return;
    }
    // 끝나지 않는 프로세스에는 알릴 사건이 없다. 기한은 그 실패를 알리는 데만 쓴다.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), main, ^{ answer(false); });
}
