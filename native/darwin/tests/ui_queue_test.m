// UI 호출자의 이벤트 잠금을 해제한 뒤에만 콜백을 실행하는지 검사한다.
#import <Foundation/Foundation.h>
#import "ui_queue.h"

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
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (!calls && deadline.timeIntervalSinceNow > 0) {
        [NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode beforeDate:deadline];
    }
    if (calls != 1) failed = YES;
    fprintf(failed ? stderr : stdout, "%s: UI completion runs once after the caller releases its event lock\n",
        failed ? "FAIL" : "PASS");
    [eventLock release];
    return failed ? 1 : 0;
}}
