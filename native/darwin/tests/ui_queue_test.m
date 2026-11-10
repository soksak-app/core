// Checks that callbacks run only after the event lock of the UI caller is released,
// and that a delayed callback runs once on the main queue after the callbacks enqueued without delay.
#import <Foundation/Foundation.h>
#import "ui_queue.h"
#import "support/event_wait.h"

static NSLock *eventLock;
static int calls;
static BOOL failed;

static void completed(uintptr_t context) {
    BOOL unlocked = [eventLock tryLock];
    if (!NSThread.isMainThread || !unlocked || context != 123 || calls != 0) failed = YES;
    if (unlocked) [eventLock unlock];
    calls++;
}

static int delayedCalls;
static int immediateCalls;

static void delayed(uintptr_t context) {
    if (!NSThread.isMainThread || context != 456 || immediateCalls != 1 || delayedCalls != 0) failed = YES;
    delayedCalls++;
}

static void immediate(uintptr_t context) {
    if (!NSThread.isMainThread || context != 789 || delayedCalls != 0) failed = YES;
    immediateCalls++;
}

int main(void) { @autoreleasepool {
    eventLock = [NSLock new];
    [eventLock lock];
    sp_ui_enqueue(completed, 123);
    if (calls != 0) failed = YES;
    [eventLock unlock];
    // The UI queue runs each callback in a block of the main queue.
    eventWait(@"the UI completion runs", ^BOOL { return calls > 0; });
    if (calls != 1) failed = YES;
    fprintf(failed ? stderr : stdout, "%s: UI completion runs once after the caller releases its event lock\n",
        failed ? "FAIL" : "PASS");
    BOOL failedBefore = failed;
    sp_ui_enqueue_after(50 * NSEC_PER_MSEC, delayed, 456);
    sp_ui_enqueue(immediate, 789);
    if (delayedCalls != 0 || immediateCalls != 0) failed = YES;
    eventWait(@"the delayed UI completion runs", ^BOOL { return delayedCalls > 0; });
    if (delayedCalls != 1 || immediateCalls != 1) failed = YES;
    fprintf(failed && !failedBefore ? stderr : stdout, "%s: a delayed UI completion runs once on the main queue after the completions without delay\n",
        failed && !failedBefore ? "FAIL" : "PASS");
    [eventLock release];
    return failed ? 1 : 0;
}}
