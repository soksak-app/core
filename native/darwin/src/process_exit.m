#import <Foundation/Foundation.h>
#import <errno.h>
#import <signal.h>
#import "process_exit.h"
#import "event_ring.h"
#import "observe.h"

// A wait that has not answered, by the context of its caller. Handled only on the main thread.
@interface SPProcessExitWait : NSObject {
@public
    pid_t pid;
    dispatch_source_t source;
    sp_process_exit_done done;
    void *context;
}
@end

@implementation SPProcessExitWait
@end

static NSMutableArray<SPProcessExitWait *> *waits;

static SPProcessExitWait *waitOf(void *context) {
    for (SPProcessExitWait *wait in waits) {
        if (wait->context == context) return wait;
    }
    return nil;
}

static void answer(SPProcessExitWait *wait, bool exited) {
    if ([waits indexOfObjectIdenticalTo:wait] == NSNotFound) return;
    [[wait retain] autorelease];
    [waits removeObjectIdenticalTo:wait];
    if (wait->source) dispatch_source_cancel(wait->source);
    wait->done(wait->context, exited);
}

void sp_process_when_exited(pid_t pid, sp_process_exit_done done, void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_process_when_exited requires the main thread");
    dispatch_queue_t main = dispatch_get_main_queue();
    if (!waits) waits = [[NSMutableArray alloc] init];
    SPProcessExitWait *wait = [[[SPProcessExitWait alloc] init] autorelease];
    wait->pid = pid;
    wait->done = done;
    wait->context = context;
    [waits addObject:wait];
    dispatch_source_t source = sp_observe_process_exit("process_exit", SP_OBSERVE_RECORD, pid, main, ^{ answer(wait, true); });
    if (!source) {
        // The entrance stored the event `native.observe.failed`. The wait cannot be made, so the caller learns that the process did not end.
        dispatch_async(main, ^{ answer(wait, false); });
        return;
    }
    wait->source = source;
    dispatch_source_set_cancel_handler(source, ^{ dispatch_release(source); });
    dispatch_resume(source);
    // A process that ended before registration produces no notification. After registration, a process that does not exist has ended. A process of
    // another user returns EPERM and is alive.
    if (kill(pid, 0) != 0 && errno == ESRCH) dispatch_async(main, ^{ answer(wait, true); });
}

void sp_process_exit_end(void *context) {
    NSCAssert(NSThread.isMainThread, @"sp_process_exit_end requires the main thread");
    SPProcessExitWait *wait = waitOf(context);
    if (!wait) return;
    char fields[64];
    snprintf(fields, sizeof fields, "{\"pid\":%d}", wait->pid);
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_INFO, "native.process.exit_wait_ended", fields);
    answer(wait, false);
}
