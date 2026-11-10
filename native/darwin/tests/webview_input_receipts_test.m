// Injects, at the boundary, the absence of the mouse handling APIs that registration and receipt completion require.
#import <Cocoa/Cocoa.h>
#import "webview_input.h"
#import "support/records.h"
#import "event_ring.h"
#import "private/webkit.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static void until(BOOL (^condition)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!condition() && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    if (!condition()) { fprintf(stderr, "FAIL: receipt fixture timed out\n"); exit(1); }
}
// Runs the main loop until the condition holds or the interval ends, for a completion that must not depend on a later step.
static void within(NSTimeInterval interval, BOOL (^condition)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:interval];
    while (!condition() && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

// Runs the run loop until condition holds or seconds pass; the caller checks the condition.
static void within(NSTimeInterval seconds, BOOL (^condition)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!condition() && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

// The receipts that the test posted and the web process has not answered, and the drains that wait for them.
static NSUInteger receiptsInFlight;
static NSMutableArray *deferredDrains;

@interface SPReceiptView : WKWebView
@property(nonatomic) BOOL missingDrain;
@property(nonatomic) BOOL missingIgnore;
@property(nonatomic) NSUInteger drains;
// If hold is set, does not run the drain callback immediately and keeps it in held. The test runs it at the moment it
// chooses.
@property(nonatomic) BOOL hold;
@property(nonatomic, copy) void (^held)(void);
// The answer of _webProcessIsResponsive, which the test changes with its key-value notification.
@property(nonatomic) BOOL unresponsive;
// If inputMethod is set, the view has an input context, as WebKit has while a text field of the document has focus.
@property(nonatomic) BOOL inputMethod;
@end
@implementation SPReceiptView
- (BOOL)respondsToSelector:(SEL)selector {
    if (selector == @selector(_doAfterProcessingAllPendingMouseEvents:) && self.missingDrain) return NO;
    if (selector == @selector(_setIgnoresMouseMoveEvents:) && self.missingIgnore) return NO;
    return [super respondsToSelector:selector];
}
- (BOOL)_webProcessIsResponsive {
    return !self.unresponsive;
}
- (NSTextInputContext *)inputContext {
    return self.inputMethod ? [[[NSTextInputContext alloc] initWithClient:(id<NSTextInputClient>)self] autorelease] : nil;
}
- (void)_doAfterProcessingAllPendingMouseEvents:(void (^)(void))done {
    self.drains++;
    if (self.hold) self.held = done;
    else if (receiptsInFlight > 0) [deferredDrains addObject:[[done copy] autorelease]];
    else done();
}
@end

// Injects a received message in a separate content world. input_inject_test verifies the real trusted input order. WebKit
// answers the receipt of an event before the end of its handling of that event, so a drain asked while a receipt is on its way
// ends after the receipt, as the fixture view defers it.
static void postReceipt(SPReceiptView *view) {
    receiptsInFlight++;
    [view evaluateJavaScript:@"webkit.messageHandlers.soksakInputReceipt.postMessage('pointerdown'); null"
        inFrame:nil inContentWorld:[WKContentWorld worldWithName:@"soksak-input"]
        completionHandler:^(id value, NSError *error) {
            if (error) { fprintf(stderr, "FAIL: injected receipt: %s\n", error.localizedDescription.UTF8String); exit(1); }
            if (--receiptsInFlight > 0) return;
            NSArray *drains = [[deferredDrains copy] autorelease];
            [deferredDrains removeAllObjects];
            for (void (^drain)(void) in drains) drain();
        }];
}

int main(void) { @autoreleasepool {
    // The records that this test reads include events below the level error, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    deferredDrains = [NSMutableArray array];
    SPReceiptView *view = [[[SPReceiptView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    view.missingDrain = YES;
    BOOL accepted = webviewInputRegister(view);
    check(!accepted, @"registration rejects an unavailable pending-mouse drain API");
    if (accepted) webviewInputUnregister(view);
    view.missingIgnore = YES;
    NSString *refused = capturedRecords(^{ check(!webviewInputRegister(view), @"registration rejects an unavailable pointer tracking API"); });
    view.missingIgnore = NO;
    check([refused containsString:@" error native webview input: _setIgnoresMouseMoveEvents: is unavailable"],
        [NSString stringWithFormat:@"a refused registration is recorded with its reason (got %@)", refused]);
    view.missingDrain = NO;
    check(webviewInputRegister(view), @"available pointer APIs register");
    [view loadHTMLString:@"<!doctype html><script>window.ready=true</script>" baseURL:nil];
    __block BOOL loaded = NO;
    until(^BOOL {
        if (!loaded && !view.loading && view.URL) {
            [view evaluateJavaScript:@"window.ready===true" completionHandler:^(id value, NSError *error) {
                if (error) { fprintf(stderr, "FAIL: load: %s\n", error.localizedDescription.UTF8String); exit(1); }
                loaded = [value boolValue];
            }];
        }
        return loaded;
    });
    __block NSUInteger sent = 0, completed = 0;
    __block BOOL received = YES;
    view.missingDrain = YES;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend { sent++; return SPInputSendRefused; }, ^(BOOL value) { received=value; completed++; });
    until(^BOOL { return completed > 0; });
    check(sent == 0 && completed == 1 && !received, @"capability loss before delivery rejects without sending");
    view.missingDrain = NO;
    completed=0; received=YES; view.drains=0;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend {
        view.missingDrain=YES; postReceipt(view); return SPInputSendDelivered;
    }, ^(BOOL value) { received=value; completed++; });
    until(^BOOL { return completed > 0; });
    // The receipt is the end of the input (docs/spec/exposure.md#methods): no step of WebKit after it is consulted.
    check(received && completed == 1 && view.drains == 1, @"the receipt completes the input without the drain API after the send");
    view.missingDrain=NO; completed=0; received=NO; view.drains=0;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend {
        check(view.drains == 1, @"pending work drains before send"); postReceipt(view); return SPInputSendDelivered;
    }, ^(BOOL value) { received=value; completed++; });
    until(^BOOL { return completed > 0; });
    check(received && completed == 1 && view.drains == 1,
        [NSString stringWithFormat:@"a receipt completes the input without a drain after it (drains %lu)", (unsigned long)view.drains]);
    // A down returns at its receipt also while WebKit still holds mouse work that the receipt does not wait for.
    completed=0; received=NO; view.drains=0; view.held=nil;
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL { view.hold=YES; postReceipt(view); return YES; },
        ^(BOOL value) { received=value; completed++; });
    within(1, ^BOOL { return completed > 0; });
    check(received && completed == 1 && view.held == nil,
        [NSString stringWithFormat:@"a down returns at its receipt while WebKit holds pending mouse work (completed %lu)",
            (unsigned long)completed]);
    if (view.held) view.held();
    within(1, ^BOOL { return completed > 0; });
    view.hold=NO; view.held=nil;
    // The press of a key window is awaited twice, by the sender and by the monitor of the press origin. One receipt answers both.
    completed=0; received=NO;
    __block BOOL heardByMonitor = NO;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend {
        webviewInputReceiveThenDrain(view, @"pointerdown", ^(BOOL value) { heardByMonitor = value; });
        postReceipt(view);
        return SPInputSendDelivered;
    }, ^(BOOL value) { received=value; completed++; });
    until(^BOOL { return completed > 0; });
    until(^BOOL { return heardByMonitor; });
    check(received && heardByMonitor, @"one receipt answers every wait of its type");
    // If sending is rejected, ends the wait as a failure and records the reason.
    view.hold=NO; view.held=nil; completed=0; received=YES;
    NSString *refusedSend = capturedRecords(^{
        webviewInputSendThen(view, @"pointerdown", ^SPInputSend { return SPInputSendRefused; }, ^(BOOL value) { received=value; completed++; });
        until(^BOOL { return completed > 0; });
    });
    check(!received && completed == 1 && [refusedSend containsString:@" error native webview input: send of pointerdown was refused"],
        [NSString stringWithFormat:@"a refused send ends the wait and is recorded (got %@)", refusedSend]);
    // The wait of an input that WebKit handled without a receipt ends at the end of that handling, not at a limit.
    view.hold=NO; view.held=nil; completed=0; received=YES;
    NSString *handled = capturedRecords(^{
        webviewInputSendThen(view, @"pointerdown", ^SPInputSend { return SPInputSendDelivered; },
            ^(BOOL value) { received=value; completed++; });
        within(5, ^BOOL { return completed > 0; });
    });
    check(completed == 1 && !received, @"an input that WebKit handled without a receipt ends at the end of that handling");
    check([handled containsString:@" error native webview input: wait for pointerdown ended: WebKit handled the mouse events without the receipt"],
        [NSString stringWithFormat:@"the end of the handling without a receipt is recorded (got %@)", handled]);
    // An input that reached another view ends in the turn that sends it.
    completed=0; received=YES;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend { return SPInputSendElsewhere; },
        ^(BOOL value) { received=value; completed++; });
    within(5, ^BOOL { return completed > 0; });
    check(completed == 1 && !received, @"an input that reached another view ends without a receipt");
    // The close of the window and a web process that stops answering end a pending wait once.
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 300, 200) styleMask:NSWindowStyleMaskTitled
        backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    [window.contentView addSubview:view];
    view.hold=YES; view.held=nil; completed=0; received=YES; sent=0;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend { sent++; return SPInputSendDelivered; },
        ^(BOOL value) { received=value; completed++; });
    NSString *closedRecords = capturedRecords(^{
        [window close];
        within(5, ^BOOL { return completed > 0; });
    });
    check(completed == 1 && !received && sent == 0, @"the close of the window ends a pending wait once without sending");
    check([closedRecords containsString:@" error native webview input: wait for pointerdown ended: the window closed"],
        [NSString stringWithFormat:@"the close of the window is recorded as the end of the wait (got %@)", closedRecords]);
    if (view.held) { void (^held)(void) = view.held; view.held = nil; held(); }
    check(completed == 1, @"the held drain after the close completes nothing again");
    [view removeFromSuperview];
    [window release];
    view.held=nil; completed=0; received=YES;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend { return SPInputSendDelivered; },
        ^(BOOL value) { received=value; completed++; });
    NSString *stopped = capturedRecords(^{
        [view willChangeValueForKey:@"_webProcessIsResponsive"];
        view.unresponsive = YES;
        [view didChangeValueForKey:@"_webProcessIsResponsive"];
        within(5, ^BOOL { return completed > 0; });
    });
    view.unresponsive = NO;
    check(completed == 1 && !received, @"a web process that stops answering ends a pending wait once");
    check([stopped containsString:@" error native webview input: wait for pointerdown ended: the web process stopped answering"],
        [NSString stringWithFormat:@"the stop of the web process is recorded as the end of the wait (got %@)", stopped]);
    if (view.held) { void (^held)(void) = view.held; view.held = nil; held(); }
    // Through the input method, the end of the handling of WebKit does not end the wait, because the input method can still hold
    // the event; AppKit tells the host nothing of it, so the wait has no limit and ends at the next press or key event that the
    // application receives.
    view.hold=NO; view.held=nil; view.inputMethod=YES; completed=0; received=YES;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend { return SPInputSendDelivered; },
        ^(BOOL value) { received=value; completed++; });
    within(1.5, ^BOOL { return completed > 0; });
    check(completed == 0, @"a wait through the input method has no limit and outlasts the end of the handling of WebKit");
    NSString *nextInput = capturedRecords(^{
        NSEvent *event = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:0 timestamp:0
            windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:56];
        [NSApp sendEvent:event];
        within(5, ^BOOL { return completed > 0; });
    });
    check(completed == 1 && !received, @"the next key event that the application receives ends a wait through the input method once");
    check([nextInput containsString:@" error native webview input: wait for pointerdown ended: the application received another press or key event"],
        [NSString stringWithFormat:@"the next input is recorded as the end of the wait (got %@)", nextInput]);
    // A receipt through the input method ends its wait as received.
    completed=0; received=NO;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend { postReceipt(view); return SPInputSendDelivered; },
        ^(BOOL value) { received=value; completed++; });
    within(5, ^BOOL { return completed > 0; });
    check(completed == 1 && received, @"a receipt through the input method ends its wait as received");
    view.inputMethod=NO;
    view.hold=YES;
    // If unregistering ends the wait, the late drain is not sent and does not complete again.
    view.held=nil; completed=0; received=YES; sent=0;
    webviewInputSendThen(view, @"pointerdown", ^SPInputSend { sent++; return SPInputSendRefused; },
        ^(BOOL value) { received=value; completed++; });
    NSString *ended = capturedRecords(^{ webviewInputUnregister(view); });
    check([ended containsString:@" info native webview input: wait for pointerdown ended by the end of the registration"],
        [NSString stringWithFormat:@"a wait that the end of the registration completes is recorded (got %@)", ended]);
    check(view.held != nil && completed == 1 && !received, @"unregistration completes the pending wait once");
    if (view.held) view.held();
    check(sent == 0 && completed == 1,
        [NSString stringWithFormat:@"unregistration cancels its held pre-send drain (sent %lu, completed %lu)",
            (unsigned long)sent, (unsigned long)completed]);
    view.hold=NO; view.held=nil;
    check(!NSApp.isActive, @"receipt capability checks remain inactive");
    return failures ? 1 : 0;
}}
