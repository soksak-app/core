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
    // A process that ended before registration produces no notification. After registration, a process that does not exist has ended. A process of
    // another user returns EPERM and is alive.
    if (kill(pid, 0) != 0 && errno == ESRCH) {
        dispatch_async(main, ^{ answer(true); });
        return;
    }
    // A process that does not end has no event to report. The deadline is used only to report that failure.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), main, ^{ answer(false); });
}
