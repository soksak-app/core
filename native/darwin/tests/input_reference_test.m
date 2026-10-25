// The input reference owns its state and lifetime without activating or inserting native keys.
#import <Cocoa/Cocoa.h>
#import "event_ring.h"
#import "input_reference.h"
#import "support/records.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
@interface SPReferenceReply : NSObject
@property(retain) NSDictionary *value;
@property(copy) NSString *failure;
@property(copy) NSString *json;
@property NSUInteger count;
@end
@implementation SPReferenceReply
- (void)dealloc { [_value release]; [_failure release]; [_json release]; [super dealloc]; }
@end
static void replied(void *context, const char *value, const char *failure) {
    SPReferenceReply *reply = context;
    reply.count++;
    if (failure) reply.failure = @(failure);
    if (value) {
        reply.json = @(value);
        NSError *error = nil;
        reply.value = [NSJSONSerialization JSONObjectWithData:[reply.json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error];
        check(error == nil, [NSString stringWithFormat:@"reply is valid JSON: %@", error]);
    }
}
static SPReferenceReply *request(NSWindow *window, const char *action, const char *expected) {
    SPReferenceReply *reply = [[[SPReferenceReply alloc] init] autorelease];
    sp_input_reference(window, action, expected, replied, reply);
    return reply;
}
static NSTextView *reference(NSWindow *window) {
    for (NSView *view in window.contentView.subviews) if ([view isKindOfClass:NSTextView.class]) return (NSTextView *)view;
    return nil;
}
static void drain(void) {
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:0.05];
    while ([limit timeIntervalSinceNow] > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:limit inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
}
int main(void) { @autoreleasepool {
    const int8_t allLevels[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(allLevels), @"the policy stores every level for the timer event assertions");
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    check([request(window, "read", NULL).value[@"open"] isEqual:@NO], @"an unopened reference is closed");
    NSResponder *before = window.firstResponder;
    SPReferenceReply *opened = request(window, "open", NULL);
    NSTextView *view = reference(window);
    check(opened.count == 1 && opened.failure == nil && view != nil, @"open creates an ordinary text view and replies once");
    check(window.firstResponder == before && !NSApp.active && !window.keyWindow, @"open neither focuses nor activates");
    check([opened.value[@"document"] isEqual:@""] && [opened.value[@"marked"] isEqual:NSNull.null], @"the reference starts with an empty unmarked document");
    [view insertText:@"a😀" replacementRange:NSMakeRange(NSNotFound, 0)];
    NSView *compositor = [[[NSView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:compositor positioned:NSWindowBelow relativeTo:view];
    NSPoint target = [view convertPoint:NSMakePoint(8, 8) toView:window.contentView];
    check([[window.contentView hitTest:target] isDescendantOf:view], @"the input reference receives hit tests above the compositor");
    [window setContentSize:NSMakeSize(720, 560)];
    SPReferenceReply *resized = request(window, "read", NULL);
    check([resized.value[@"frame"][@"x"] doubleValue] == 20 && [resized.value[@"frame"][@"y"] doubleValue] == 20,
        @"read reports the actual top-left content frame after resize");
    SPReferenceReply *read = request(window, "read", NULL);
    check([read.value[@"document"] isEqual:@"a😀"] && [read.value[@"selected"][@"location"] integerValue] == 3, @"read preserves the ordinary text document and UTF-16 selection");
    check([request(window, "open", NULL).value[@"document"] isEqual:@"a😀"] && reference(window) == view, @"repeated open preserves the control and document");
    SPReferenceReply *emptyWait = request(window, "wait", "");
    check(emptyWait.count == 0, @"an empty expected document remains distinct from a missing document");
    check([request(window, "wait", "another").failure containsString:@"pending"], @"a concurrent wait fails explicitly");
    [view setString:@""];
    drain();
    check(emptyWait.count == 1 && emptyWait.failure == nil, @"the empty expected document completes exactly once");
    check([request(window, "wait", NULL).failure containsString:@"document"], @"wait rejects a missing document");
    check([request(window, "read", "unexpected").failure containsString:@"document"], @"read rejects an extra document");
    check(request(window, "focus", NULL).failure == nil, @"focus selects the ordinary text view without activation");
    SPReferenceReply *focused = request(window, "read", NULL);
    check([focused.value[@"focused"] isEqual:@YES] && !NSApp.active && !window.keyWindow, @"read reports focus without activating the application");
    check([focused.json containsString:@"\"focused\":true"], @"the serialized focus state is a JSON boolean");
    SPReferenceReply *waiting = request(window, "wait", "done");
    check(waiting.count == 0, @"wait remains pending before the expected document");
    [view setString:@"done"];
    drain();
    check(waiting.count == 1 && [waiting.value[@"document"] isEqual:@"done"], @"text-storage changes complete the pending wait once");
    [view setMarkedText:@"m" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(0, view.string.length)];
    SPReferenceReply *marked = request(window, "wait", "m");
    check(marked.count == 0, @"an equal document with marked text is not complete");
    [view unmarkText];
    drain();
    check(marked.count == 1 && marked.failure == nil, @"unmark without a document change completes the wait");
    SPReferenceReply *cancelled = request(window, "wait", "later");
    check([request(window, "close", NULL).value[@"open"] isEqual:@NO] && reference(window) == nil, @"close removes the reference");
    check(window.firstResponder != view, @"close removes the reference from the responder chain");
    check(cancelled.count == 1 && [cancelled.failure containsString:@"closed"], @"close cancels the pending wait exactly once");
    check([request(window, "close", NULL).value[@"open"] isEqual:@NO], @"close is idempotent");
    request(window, "open", NULL);
    NSWindow *other = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    other.releasedWhenClosed = NO;
    request(other, "open", NULL);
    [reference(other) setString:@"other"];
    check([request(window, "read", NULL).value[@"document"] isEqual:@""] &&
        [request(other, "read", NULL).value[@"document"] isEqual:@"other"], @"separate windows own independent reference documents");
    __block SPReferenceReply *timed = nil;
    NSArray<NSDictionary *> *timeoutEvents = capturedEvents(^{
        timed = request(other, "wait", "never");
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:6];
        while (!timed.count && deadline.timeIntervalSinceNow > 0)
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:deadline];
    });
    check(timed.count == 1 && [timed.failure containsString:@"within 5 seconds"], @"an unmet document fails within the declared wait bound");
    NSArray<NSDictionary *> *timeoutRegistrations = [timeoutEvents filteredArrayUsingPredicate:
        [NSPredicate predicateWithFormat:@"name == 'native.observe.registered' AND fields.source == 'input.reference.timeout'"]];
    NSArray<NSDictionary *> *timeoutDeliveries = [timeoutEvents filteredArrayUsingPredicate:
        [NSPredicate predicateWithFormat:@"name == 'native.observe.delivered' AND fields.source == 'input.reference.timeout'"]];
    NSDictionary *timeoutRegistration = timeoutRegistrations.count == 1 ? timeoutRegistrations[0][@"fields"] : @{};
    // Four earlier waits registered the same source; this controlled phase registers it a fifth time.
    check(timeoutRegistrations.count == 1 && [timeoutRegistration[@"kind"] isEqual:@"timer"]
        && [timeoutRegistration[@"target"] isEqual:@"input reference document wait"]
        && [timeoutRegistration[@"mode"] isEqual:@"record"] && [timeoutRegistration[@"registrations"] intValue] == 5
        && timeoutDeliveries.count == 1 && [timeoutDeliveries[0][@"fields"][@"count"] intValue] == 1
        && [timeoutEvents indexOfObject:timeoutRegistrations[0]] < [timeoutEvents indexOfObject:timeoutDeliveries[0]],
        [NSString stringWithFormat:@"the wait timer registration and delivery are recorded: %@", timeoutEvents]);
    [reference(other) setString:@"never"];
    drain();
    check(timed.count == 1, @"a timed-out wait never completes a second time");
    request(other, "close", NULL);
    [other close];
    [other release];
    SPReferenceReply *closed = request(window, "wait", "later");
    [window close];
    check(closed.count == 1 && [closed.failure containsString:@"closed"] && reference(window) == nil, @"window closure cancels the wait and removes the reference");
    check([request(nil, "open", NULL).failure containsString:@"window"], @"a missing window fails explicitly");
    check([request(window, "invalid", NULL).failure containsString:@"action"], @"an unknown action fails explicitly");
    [window release];
    SPReferenceReply *releasedWait = [[SPReferenceReply alloc] init];
    @autoreleasepool {
    NSWindow *released = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    released.releasedWhenClosed = NO;
    request(released, "open", NULL);
    sp_input_reference(released, "wait", "later", replied, releasedWait);
    [released release];
    }
    drain();
    check(releasedWait.count == 1 && [releasedWait.failure containsString:@"released"], @"window release cancels its pending wait without reading the released window");
    [releasedWait release];
    SPReferenceReply *changedRelease = [[SPReferenceReply alloc] init];
    @autoreleasepool {
        NSWindow *changing = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 480)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        changing.releasedWhenClosed = NO;
        request(changing, "open", NULL);
        sp_input_reference(changing, "wait", "ready", replied, changedRelease);
        [reference(changing) setString:@"ready"];
        [changing release];
    }
    drain();
    check(changedRelease.count == 1 && [changedRelease.failure containsString:@"released"], @"window release cancels a matching change queued before release");
    [changedRelease release];
    return failures ? 1 : 0;
} }
