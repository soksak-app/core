#import "event_wait.h"
#import <Cocoa/Cocoa.h>
#include <stdio.h>
#include <stdlib.h>

static CFRunLoopSourceRef wakeSource;

static void performWake(void *info) { (void)info; }

// The source of eventWake is on the run loop of the main thread in its common modes before the check runs, so a wake that
// another thread sends before the first wait is not lost.
__attribute__((constructor)) static void createWakeSource(void) {
    CFRunLoopSourceContext context = {0};
    context.perform = performWake;
    wakeSource = CFRunLoopSourceCreate(kCFAllocatorDefault, 0, &context);
    CFRunLoopAddSource(CFRunLoopGetMain(), wakeSource, kCFRunLoopCommonModes);
}

void eventWake(void) {
    CFRunLoopSourceSignal(wakeSource);
    CFRunLoopWakeUp(CFRunLoopGetMain());
}

void eventWait(NSString *what, BOOL (^done)(void)) {
    if (!NSThread.isMainThread) {
        fprintf(stderr, "FAIL: the wait for %s does not run on the main thread\n", what.UTF8String);
        exit(1);
    }
    if (done()) return;
    fprintf(stdout, "WAIT %s\n", what.UTF8String);
    fflush(stdout);
    for (;;) {
        // The events that arrived are dispatched before the condition is judged, so an input or a window change reaches its
        // window first. Taking an event that is already queued does not wait.
        if (NSApp) {
            NSEvent *event;
            while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast
                inMode:NSDefaultRunLoopMode dequeue:YES])) [NSApp sendEvent:event];
        }
        if (done()) return;
        // Returns after the run loop handled one source; a timer alone does not end the turn.
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0e10, true);
    }
}
