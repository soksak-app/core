// The stop of a recording seals its requests at the boundary and settles every still already requested before it writes
// stills.jsonl. A still requested at or after the time of the stop ends the wait of the stop; from then no later still is
// requested, and a still that the window server still takes when the requests close is written and recorded. A still that fails
// while the stop waits fails the stopped recording with its index, and the next recording starts without that error. A
// recording stores one start, one first-still, one stop and one end lifecycle event, all of its session.
#import "../src/capture.m"
#import "support/records.h"
#import "support/run_until.h"
#import "support/temporary_folder.h"
#include <stdlib.h>

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The window server is the real one. The fault point SOKSAK_FAULT_CAPTURE_IMAGE holds the third request of a recording, so a
// still is in flight when the requests close, until the test posts the release notification; hold-third-none then gives no image
// and hold-third takes the real image.
// Waits until the third request of the recording is in the window server.
static BOOL thirdRequestEntered(void) {
    NSCondition *state = captureFaultState();
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:30];
    BOOL entered = YES;
    [state lock];
    while (captureFaultImageRequests < 3 && entered) entered = [state waitUntilDate:limit];
    entered = captureFaultImageRequests >= 3;
    [state unlock];
    return entered;
}

static uint64_t ticks(id value) {
    return [value isKindOfClass:NSString.class] ? strtoull([value UTF8String], NULL, 10) : 0;
}

static NSArray<NSDictionary *> *lifecycle(NSArray<NSDictionary *> *events, NSString *phase) {
    NSMutableArray *found = [NSMutableArray array];
    for (NSDictionary *event in events)
        if ([event[@"name"] isEqual:@"native.capture.lifecycle"] && [event[@"fields"][@"phase"] isEqual:phase]) [found addObject:event];
    return found;
}

// Records window into directory until a stop at the time when the third still is in the window server, and judges the stop. With
// fails the held still gives no image.
static void recordWithHeldStill(NSWindow *window, NSString *directory, BOOL fails) {
    NSString *label = fails ? @"a held still that fails" : @"a held still that is written";
    setenv("SOKSAK_FAULT_CAPTURE_IMAGE", fails ? "hold-third-none" : "hold-third", 1);
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:NO attributes:nil error:NULL];
    char *error = NULL;
    bool opened = sp_capture_open(window.windowNumber, false, &error);
    check(opened, [NSString stringWithFormat:@"%@: the window opens for a recording (%s)", label, error ?: ""]);
    free(error); error = NULL;
    __block bool started = false;
    __block char *startError = NULL;
    NSArray<NSDictionary *> *startEvents = opened ? capturedEvents(^{
        started = sp_capture_start(directory.fileSystemRepresentation, 10, 0, 4096, 1, &startError);
    }) : @[];
    check(started, [NSString stringWithFormat:@"%@: the recording starts (%s)", label, startError ?: ""]);
    free(startError);
    if (!started) return;
    SPCaptureRecording *recording = nil;
    @synchronized ([SPCaptureRecording class]) { recording = [captureRecording retain]; }
    NSString *session = recording.session;
    NSArray *starts = lifecycle(startEvents, @"start"), *firsts = lifecycle(startEvents, @"first-still");
    check(starts.count == 1 && firsts.count == 1 && [starts[0][@"fields"][@"session"] isEqual:session]
        && [firsts[0][@"fields"][@"session"] isEqual:session] && [firsts[0][@"fields"][@"index"] intValue] == 0,
        [NSString stringWithFormat:@"%@: the start stores one start and one first-still event of its session (%@)", label, startEvents]);
    // The third still is in the window server: a stop at this time ends at a later still, while this one is in flight.
    check(thirdRequestEntered(), [NSString stringWithFormat:@"%@: the third still is in the window server", label]);
    double after = sp_capture_clock();
    mach_timebase_info_data_t timebase = recording.timebase;
    uint64_t afterTicks = (uint64_t)(after * 1e6 * timebase.denom / timebase.numer);
    __block int written = -1;
    __block BOOL stopped = NO;
    __block NSArray<NSDictionary *> *events = nil;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSArray *stored = capturedEvents(^{ written = sp_capture_stop(after, 2); });
        dispatch_async(dispatch_get_main_queue(), ^{
            events = [stored retain];
            stopped = YES;
        });
    });
    sp_run_until("the stop closes the requests", ^BOOL {
        @synchronized (recording) { return recording.closed; }
    });
    // The requests closed while the held still is in the window server. The request queue finishes the handler that ran
    // before the close, so the stills requested by then are all the stills of the recording.
    dispatch_sync(captureRequests, ^{});
    int callsAtClose = 0;
    @synchronized (recording) { callsAtClose = (int)recording.nextIndex; }
    uint64_t releasedTicks = mach_absolute_time();
    char releaseName[64];
    sp_capture_fault_release_name(getpid(), releaseName, sizeof releaseName);
    check(notify_post(releaseName) == NOTIFY_STATUS_OK, [NSString stringWithFormat:@"%@: the release notification is posted", label]);
    sp_run_until("the stop returns", ^BOOL { return stopped; });
    NSString *stopError = [NSString stringWithUTF8String:sp_capture_error()];
    if (fails) {
        NSString *want = [NSString stringWithFormat:@"still 2: the window server gave no image of window %ld", (long)window.windowNumber];
        check([stopError isEqual:want],
            [NSString stringWithFormat:@"a still that fails while the stop waits fails the stopped recording with its index (%d, %@)",
                written, stopError]);
    } else {
        check(written > 0 && stopError.length == 0,
            [NSString stringWithFormat:@"the stop writes the recording without error (%d, %@)", written, stopError]);
    }
    NSCondition *requestState = captureFaultState();
    [requestState lock];
    int windowServerCalls = (int)captureFaultImageRequests;
    [requestState unlock];
    unsetenv("SOKSAK_FAULT_CAPTURE_IMAGE");
    check(windowServerCalls == callsAtClose, [NSString stringWithFormat:
        @"%@: no still is requested after the requests close (%d requested at the close, %d window server calls)", label,
        callsAtClose, windowServerCalls]);

    NSString *rowsText = [NSString stringWithContentsOfFile:[directory stringByAppendingPathComponent:@"stills.jsonl"]
        encoding:NSUTF8StringEncoding error:NULL];
    NSArray<NSString *> *lines = [[rowsText ?: @"" stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]
        componentsSeparatedByString:@"\n"];
    check(lines.count == 4096, [NSString stringWithFormat:@"%@: stills.jsonl holds every planned still (%lu rows)", label,
        (unsigned long)lines.count]);
    int requested = 0, settled = 0, rowsWritten = 0, unsettled = 0, requestedNotRequested = 0;
    BOOL boundary = NO, heldSettled = NO, gapInRequests = NO, seenNotRequested = NO;
    for (NSString *line in lines) {
        NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
        BOOL wasRequested = [row[@"requested"] isKindOfClass:NSString.class];
        if (!wasRequested) {
            seenNotRequested = YES;
            if (![row[@"outcome"] isEqual:@"not-requested"] || row[@"frame"] != NSNull.null) requestedNotRequested++;
            continue;
        }
        if (seenNotRequested) gapInRequests = YES;
        requested++;
        if ([row[@"outcome"] isEqual:@"written"] || [row[@"outcome"] isEqual:@"failed"]) settled++;
        else unsettled++;
        if ([row[@"outcome"] isEqual:@"written"]) rowsWritten++;
        if (ticks(row[@"requested"]) >= afterTicks && [row[@"completed"] isKindOfClass:NSString.class]) boundary = YES;
        if ([row[@"index"] intValue] == 2 && ticks(row[@"completed"]) >= releasedTicks)
            heldSettled = fails ? [row[@"outcome"] isEqual:@"failed"] && row[@"frame"] == NSNull.null
                && [row[@"error"] isEqual:[NSString stringWithFormat:@"the window server gave no image of window %ld", (long)window.windowNumber]]
                : [row[@"outcome"] isEqual:@"written"];
    }
    check(requested == callsAtClose && settled == requested && unsettled == 0,
        [NSString stringWithFormat:@"%@: every requested still is settled in stills.jsonl (%d requested at the close, %d in stills.jsonl, %d settled)",
            label, callsAtClose, requested, settled]);
    if (!fails) {
        check(!gapInRequests && requestedNotRequested == 0,
            @"the stills after the last request stay not requested, with no request time and no frame");
        check(boundary, @"a still requested at or after the time of the stop completed before the stop ended");
        check(heldSettled, @"the still in flight when the requests closed is written before stills.jsonl");
    } else {
        check(!gapInRequests && requestedNotRequested == 0 && boundary,
            @"a held still that fails: the stop boundary and the not-requested rows are kept");
        check(heldSettled, @"the still that failed while the stop waited is recorded as failed with its error before stills.jsonl");
    }
    check(rowsWritten == written && sp_capture_missed() == 4096 - written,
        [NSString stringWithFormat:@"%@: the stop counts the written stills and the rest as missed (%d written, %d rows, %d missed)",
            label, written, rowsWritten, sp_capture_missed()]);
    NSArray *stops = lifecycle(events, @"stop"), *ends = lifecycle(events, @"end"), *failed = lifecycle(events, @"still-failed");
    NSDictionary *stop = stops.firstObject, *end = ends.firstObject;
    BOOL failedEvent = !fails ? failed.count == 0 : failed.count == 1 && [failed[0][@"fields"][@"session"] isEqual:session]
        && [failed[0][@"fields"][@"index"] intValue] == 2;
    check(stops.count == 1 && ends.count == 1 && failedEvent && [stop[@"fields"][@"session"] isEqual:session]
        && [end[@"fields"][@"session"] isEqual:session] && [end[@"fields"][@"written"] intValue] == written,
        fails ? [NSString stringWithFormat:@"the stop of a failed held still stores one stop, one still-failed and one end event of its session (%@)", events]
            : [NSString stringWithFormat:@"the stop and end events belong to the session of the recording (%@, %@)", stop, end]);
    [events release];
    [recording release];
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: capture stop seals the requests at the boundary\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSString *directory = temporaryFolder(@"soksak-capture-stop-intake-");
    const int8_t policy[SP_CLASS_COUNT] = {SP_EVENT_DEBUG, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR, SP_EVENT_ERROR};
    check(sp_event_set_policy(policy), @"the test enables capture lifecycle events");

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 60, 40)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    // AppKit keeps the order in the open Core Animation transaction of the thread until the run loop commits it, so the test
    // commits it, and the window server lists the window once the commit returns.
    [window orderBack:nil];
    [CATransaction flush];
    // The failing recording comes first, so the recording after it shows that its error stays with it.
    recordWithHeldStill(window, [directory stringByAppendingPathComponent:@"failed"], YES);
    recordWithHeldStill(window, [directory stringByAppendingPathComponent:@"written"], NO);
    [window close];
    [window release];
    fprintf(stderr, "%s: capture stop seals the requests (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
