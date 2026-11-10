// Checks that callbacks run only after the event lock of the UI caller is released.
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
    [eventLock release];
    return failed ? 1 : 0;
}}
