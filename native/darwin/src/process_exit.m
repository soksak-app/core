#import <Foundation/Foundation.h>
#import <errno.h>
#import <signal.h>
#import "process_exit.h"
#import "event_ring.h"
#import "observe.h"

void sp_process_when_exited(pid_t pid, double seconds, sp_process_exit_done done, void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_process_when_exited requires the main thread");
    dispatch_queue_t main = dispatch_get_main_queue();
    __block bool answered = false;
    __block dispatch_source_t source = NULL;
    void (^answer)(bool) = ^(bool exited) {
        if (answered) return;
        answered = true;
        dispatch_source_cancel(source);
        done(context, exited);
    };
    source = sp_observe_process_exit("process_exit", SP_OBSERVE_RECORD, pid, main, ^{ answer(true); });
    if (!source) {
        // The entrance stored the event `native.observe.failed`. The wait cannot be made, so the caller learns that the process did not end.
        answered = true;
        dispatch_async(main, ^{ done(context, false); });
        return;
    }
    dispatch_source_set_cancel_handler(source, ^{ dispatch_release(source); });
    dispatch_resume(source);
    // A process that ended before registration produces no notification. After registration, a process that does not exist has ended. A process of
    // another user returns EPERM and is alive.
    if (kill(pid, 0) != 0 && errno == ESRCH) {
        dispatch_async(main, ^{ answer(true); });
        return;
    }
    // A process that does not end has no event to report. The deadline is used only to report that failure.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), main, ^{
        if (answered) return;
        char fields[96];
        snprintf(fields, sizeof fields, "{\"pid\":%d,\"seconds\":%g}", pid, seconds);
        sp_event(SP_EVENT_WARN, "native.process.exit_timeout", fields);
        answer(false);
    });
}
