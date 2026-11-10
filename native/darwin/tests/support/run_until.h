// Runs the current run loop until a condition holds, with no limit. The condition is judged before the run loop sleeps, after each
// pass has handled its sources, timers, main queue blocks and observers, so a change that any of them makes ends the wait at once,
// and no pass judges it on a clock. A wait that never ends leaves its WAIT line as the last record, so the runner that ends the run
// names it.
#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>
#include <stdio.h>

// A run that the runner ends keeps every line the test wrote before, so the standard output is written line by line.
__attribute__((constructor)) static void sp_run_until_line_output(void) { setvbuf(stdout, NULL, _IOLBF, 0); }

static inline void sp_run_until(const char *what, BOOL (^done)(void)) {
    fprintf(stderr, "WAIT %s\n", what);
    if (!done()) {
        CFRunLoopRef loop = CFRunLoopGetCurrent();
        CFRunLoopObserverRef judge = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, kCFRunLoopBeforeWaiting, true, 0,
            ^(CFRunLoopObserverRef observer, CFRunLoopActivity activity) {
                (void)observer; (void)activity;
                if (done()) CFRunLoopStop(loop);
            });
        CFRunLoopAddObserver(loop, judge, kCFRunLoopDefaultMode);
        while (!done()) @autoreleasepool { CFRunLoopRunInMode(kCFRunLoopDefaultMode, NSDate.distantFuture.timeIntervalSinceNow, false); }
        CFRunLoopObserverInvalidate(judge);
        CFRelease(judge);
    }
    fprintf(stderr, "reached: %s\n", what);
}
