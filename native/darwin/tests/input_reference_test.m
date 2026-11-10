// Tests reference state without activation and input readiness through the explicit activation variant.
#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#include <string.h>
#import "event_ring.h"
#import "input_inject.h"
#import "input_reference.h"
#import "input_source.h"
#import "support/event_wait.h"
#import "support/records.h"

static int failures;
static NSString *const KOREAN_2SET = @"com.apple.inputmethod.Korean.2SetKorean";
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
// A reply can come from the timer of a document wait, which does not end a turn of the run loop, so the reply wakes the wait
// of the main thread.
static void replied(void *context, const char *value, const char *failure) {
    SPReferenceReply *reply = context;
    reply.count++;
    eventWake();
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
// Dispatches AppKit events until a marker block that follows every block already on the main queue has run. The main queue
// runs its blocks in order, so the document checks that earlier notifications scheduled have run when the marker runs.
static void drain(void) {
    __block BOOL passed = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ passed = YES; });
    eventWait(@"a marker block after the document checks already on the main queue runs", ^BOOL { return passed; });
}
static NSString *currentSourceID(void) {
    char *identifier = sp_input_source_current();
    NSString *result = identifier ? [NSString stringWithUTF8String:identifier] : nil;
    free(identifier);
    return result;
}
// Selects source and waits for the answer of its adoption. The answer can come from a timer of the selection, which does not
// end a turn of the run loop, so the answer wakes the wait.
static BOOL selectAndAwaitSource(NSString *source) {
    __block BOOL answered = NO;
    __block NSString *failure = nil;
    sp_input_source_select_and_await(source.UTF8String, NULL, ^(const char *error) {
        answered = YES;
        failure = error ? [[NSString alloc] initWithUTF8String:error] : nil;
        eventWake();
    });
    eventWait([NSString stringWithFormat:@"the adoption of the input source %@ answers", source], ^BOOL { return answered; });
    BOOL adopted = failure == nil && [currentSourceID() isEqualToString:source];
    [failure release];
    return adopted;
}
static int runActivationReadiness(void) { @autoreleasepool {
    NSString *outerSource = currentSourceID();
    NSRunningApplication *outerApplication = [[NSWorkspace.sharedWorkspace.frontmostApplication retain] autorelease];
    if (outerSource.length == 0 || !outerApplication || outerApplication.processIdentifier <= 0) {
        fprintf(stderr, "FAIL: the original input source or frontmost application could not be read\n");
        return 1;
    }
    printf("PRECHECK: inputSource=%s frontmostPid=%d\n", outerSource.UTF8String,
        outerApplication.processIdentifier);
    void sp_test_declare_activation(void);
    sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 640, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    NSTextView *previousClient = [[[NSTextView alloc] initWithFrame:NSMakeRect(20, 20, 320, 80)] autorelease];
    previousClient.richText = NO;
    [window.contentView addSubview:previousClient];
    BOOL referenceOpened = NO;
    @try {
        [NSApp activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
        eventWait(@"the application becomes active with the readiness window as its key window", ^BOOL {
            return NSApp.isActive && window.isKeyWindow;
        });
        check(NSApp.isActive && window.isKeyWindow, @"the readiness window becomes active and key");

        check([window makeFirstResponder:previousClient], @"the previous text client becomes first responder");
        eventWait(@"the previous text client takes the current input context", ^BOOL {
            return window.firstResponder == previousClient
                && NSTextInputContext.currentInputContext == previousClient.inputContext;
        });
        check(window.firstResponder == previousClient && NSTextInputContext.currentInputContext == previousClient.inputContext,
            @"the previous text client owns the current input context");

        NSString *selectedSource = KOREAN_2SET;
        BOOL previousSourceReady = selectAndAwaitSource(selectedSource);
        check(previousSourceReady, [NSString stringWithFormat:@"the previous client adopts current input source %@",
            selectedSource ?: @"<unavailable>"]);
        if (!previousSourceReady) return 1;

        SPReferenceReply *opened = request(window, "open", NULL);
        referenceOpened = opened.count == 1 && opened.failure == nil;
        check(referenceOpened, @"the AppKit reference opens over the previous text client");
        if (!referenceOpened) return 1;
        SPReferenceReply *focused = request(window, "focus", NULL);
        check(focused.count == 1 && focused.failure == nil, @"the AppKit reference becomes first responder");
        if (!focused.count || focused.failure) return 1;

        BOOL referenceSourceReady = selectAndAwaitSource(selectedSource);
        if (!referenceSourceReady) {
            SPReferenceReply *state = request(window, "read", NULL);
            check(NO, [NSString stringWithFormat:@"the reference context adopts %@ after focus: %@",
                selectedSource ?: @"<unavailable>", state.json ?: @"<no reply>"]);
            return 1;
        }
        SPReferenceReply *ready = request(window, "read", NULL);
        BOOL current = [ready.value[@"inputContextCurrent"] isEqual:@YES];
        check(current && [ready.value[@"focused"] isEqual:@YES],
            [NSString stringWithFormat:@"the focused reference reports its current text input context: %@",
                ready.json ?: @"<no reply>"]);
        if (!current) return 1;

        sp_input_result down = sp_input_key(window, "g", NULL, 0, true);
        sp_input_result up = sp_input_key(window, "g", NULL, 0, false);
        check(down == SP_INPUT_DELIVERED && up == SP_INPUT_DELIVERED,
            @"the Korean g key is delivered after reference context readiness");
        SPReferenceReply *typed = request(window, "wait-document", "ㅎ");
        eventWait(@"the reference answers its wait for the document ㅎ", ^BOOL { return typed.count >= 1; });
        check(typed.count == 1 && typed.failure == nil && [typed.value[@"document"] isEqual:@"ㅎ"],
            [NSString stringWithFormat:@"the ready AppKit reference composes ㅎ (got %@)",
                typed.json ?: (typed.failure ?: @"no reply")]);
    } @finally {
        if (referenceOpened && window.contentView) request(window, "close", NULL);
        if (window.contentView) [window makeFirstResponder:window.contentView];
        BOOL sourceRestored = selectAndAwaitSource(outerSource);
        check(sourceRestored, [NSString stringWithFormat:@"the original input source %@ is restored before window close",
            outerSource]);
        [window close];
        [window release];
        BOOL appRestored = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier
            == outerApplication.processIdentifier;
        if (!appRestored && [outerApplication activateWithOptions:0]) {
            eventWait(@"the original application becomes the frontmost application", ^BOOL {
                return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == outerApplication.processIdentifier;
            });
            appRestored = YES;
        }
        check(appRestored, @"the original frontmost application is restored");
        check([currentSourceID() isEqualToString:outerSource],
            @"the original input source remains selected after focus restoration");
    }
    return failures ? 1 : 0;
} }
int main(int argc, const char *argv[]) {
    if (argc == 2 && strcmp(argv[1], "--activation-readiness") == 0) return runActivationReadiness();
    if (argc != 1) { fprintf(stderr, "FAIL: unknown input reference test option\n"); return 2; }
    @autoreleasepool {
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
    NSArray<NSDictionary *> *emptyEvents = capturedEvents(^{
        [view setString:@""];
        drain();
    });
    check(emptyWait.count == 1 && emptyWait.failure == nil,
        [NSString stringWithFormat:@"the empty expected document completes exactly once (count %lu, failure %@, document %@, events %@)",
            (unsigned long)emptyWait.count, emptyWait.failure, view.string, emptyEvents]);
    check([request(window, "wait", NULL).failure containsString:@"wait-document and wait"],
        @"wait rejects a missing document");
    check([request(window, "wait-document", NULL).failure containsString:@"wait-document and wait"],
        @"wait-document rejects a missing document");
    check([request(window, "read", "unexpected").failure containsString:@"document"], @"read rejects an extra document");
    check(request(window, "focus", NULL).failure == nil, @"focus selects the ordinary text view without activation");
    SPReferenceReply *focused = request(window, "read", NULL);
    check([focused.value[@"focused"] isEqual:@YES] && !NSApp.active && !window.keyWindow, @"read reports focus without activating the application");
    BOOL referenceContextCurrent = NSTextInputContext.currentInputContext == view.inputContext;
    check(!referenceContextCurrent, @"an inactive focused window does not activate its text input context");
    check([focused.value[@"inputContextCurrent"] isEqual:@(referenceContextCurrent)],
        @"read distinguishes first-responder focus from the current text input context");
    check([focused.json containsString:@"\"focused\":true"], @"the serialized focus state is a JSON boolean");
    SPReferenceReply *waiting = request(window, "wait", "done");
    check(waiting.count == 0, @"wait remains pending before the expected document");
    [view setString:@"done"];
    drain();
    check(waiting.count == 1 && [waiting.value[@"document"] isEqual:@"done"], @"text-storage changes complete the pending wait once");
    [view setMarkedText:@"m" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(0, view.string.length)];
    SPReferenceReply *documentOnly = request(window, "wait-document", "m");
    check(documentOnly.count == 1 && documentOnly.failure == nil
        && [documentOnly.value[@"document"] isEqual:@"m"]
        && ![documentOnly.value[@"marked"] isEqual:NSNull.null],
        @"wait-document completes at the expected document while marked text remains");
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
    // No limit ends a wait: the document never comes, and the end of the request ends the wait with that end.
    SPReferenceReply *timed = request(other, "wait", "never");
    drain();
    check(timed.count == 0, @"an unmet document keeps its wait without a limit");
    sp_input_reference_end(other, "the endpoint connection of the request closed");
    check(timed.count == 1 && [timed.failure hasPrefix:
        @"input reference did not reach the expected document before the endpoint connection of the request closed: "]
        && [timed.failure containsString:@"other"],
        [NSString stringWithFormat:@"the end of the request fails the unmet wait with its end and the state: %@", timed.failure]);
    sp_input_reference_end(other, "the window closed");
    check(timed.count == 1, @"a second end finds no wait");
    [reference(other) setString:@"never"];
    drain();
    check(timed.count == 1, @"an ended wait never completes a second time");
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
