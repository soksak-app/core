// Injects, at the boundary, the absence of the mouse handling APIs that registration and receipt completion require.
#import <Cocoa/Cocoa.h>
#import "webview_input.h"
#import "support/records.h"
#import "event_ring.h"
#import "private/webkit.h"
#import "support/event_wait.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

@interface SPReceiptView : WKWebView
@property(nonatomic) BOOL missingDrain;
@property(nonatomic) BOOL missingIgnore;
@property(nonatomic) NSUInteger drains;
// If hold is set, does not run the drain callback immediately and keeps it in held. The test runs it at the moment it
// chooses.
@property(nonatomic) BOOL hold;
@property(nonatomic, copy) void (^held)(void);
@end
@implementation SPReceiptView
- (BOOL)respondsToSelector:(SEL)selector {
    if (selector == @selector(_doAfterProcessingAllPendingMouseEvents:) && self.missingDrain) return NO;
    if (selector == @selector(_setIgnoresMouseMoveEvents:) && self.missingIgnore) return NO;
    return [super respondsToSelector:selector];
}
- (void)_doAfterProcessingAllPendingMouseEvents:(void (^)(void))done {
    self.drains++;
    if (self.hold) self.held = done;
    else done();
}
@end

// Injects a received message in a separate content world. input_inject_test verifies the real trusted input order. answered,
// when given, runs at the answer of the evaluation; the web process sends the message before that answer on the same
// connection, so the handler of the message has run when answered runs.
static void postReceipt(SPReceiptView *view, void (^answered)(void)) {
    [view evaluateJavaScript:@"webkit.messageHandlers.soksakInputReceipt.postMessage('pointerdown'); null"
        inFrame:nil inContentWorld:[WKContentWorld worldWithName:@"soksak-input"]
        completionHandler:^(id value, NSError *error) {
            if (error) { fprintf(stderr, "FAIL: injected receipt: %s\n", error.localizedDescription.UTF8String); exit(1); }
            if (answered) answered();
        }];
}

int main(void) { @autoreleasepool {
    // The records that this test reads include events below the level error, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
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
    eventWait(@"the document loads and answers that its script ran", ^BOOL {
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
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL { sent++; return NO; }, ^(BOOL value) { received=value; completed++; });
    eventWait(@"the input completes", ^BOOL { return completed > 0; });
    check(sent == 0 && completed == 1 && !received, @"capability loss before delivery rejects without sending");
    view.missingDrain = NO;
    completed=0; received=YES; view.drains=0;
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL {
        view.missingDrain=YES; postReceipt(view, nil); return YES;
    }, ^(BOOL value) { received=value; completed++; });
    eventWait(@"the input completes", ^BOOL { return completed > 0; });
    // The receipt is the end of the input (docs/spec/exposure.md#methods): no step of WebKit after it is consulted.
    check(received && completed == 1 && view.drains == 1, @"the receipt completes the input without the drain API after the send");
    view.missingDrain=NO; completed=0; received=NO; view.drains=0;
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL {
        check(view.drains == 1, @"pending work drains before send"); postReceipt(view, nil); return YES;
    }, ^(BOOL value) { received=value; completed++; });
    eventWait(@"the input completes", ^BOOL { return completed > 0; });
    check(received && completed == 1 && view.drains == 1,
        [NSString stringWithFormat:@"a receipt completes the input without a drain after it (drains %lu)", (unsigned long)view.drains]);
    // A down returns at its receipt also while WebKit still holds mouse work that the receipt does not wait for.
    completed=0; received=NO; view.drains=0; view.held=nil;
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL { view.hold=YES; postReceipt(view, nil); return YES; },
        ^(BOOL value) { received=value; completed++; });
    eventWait(@"the receipt completes the input while WebKit holds the drain", ^BOOL { return completed > 0; });
    check(received && completed == 1 && view.held == nil,
        [NSString stringWithFormat:@"a down returns at its receipt while WebKit holds pending mouse work (completed %lu)",
            (unsigned long)completed]);
    if (view.held) view.held();
    view.hold=NO; view.held=nil;
    // The press of a key window is awaited twice, by the sender and by the monitor of the press origin. One receipt answers both.
    completed=0; received=NO;
    __block BOOL heardByMonitor = NO;
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL {
        webviewInputReceive(view, @"pointerdown", 1, ^(BOOL value) { heardByMonitor = value; });
        postReceipt(view, nil);
        return YES;
    }, ^(BOOL value) { received=value; completed++; });
    eventWait(@"the input completes", ^BOOL { return completed > 0; });
    eventWait(@"the monitor of the press origin hears the receipt", ^BOOL { return heardByMonitor; });
    check(received && heardByMonitor, @"one receipt answers every wait of its type");
    // If sending is rejected, ends the wait as a failure and records the reason.
    view.hold=NO; view.held=nil; completed=0; received=YES;
    NSString *refusedSend = capturedRecords(^{
        webviewInputSendThen(view, @"pointerdown", 1, ^BOOL { return NO; }, ^(BOOL value) { received=value; completed++; });
        eventWait(@"the input completes", ^BOOL { return completed > 0; });
    });
    check(!received && completed == 1 && [refusedSend containsString:@" error native webview input: send of pointerdown was refused"],
        [NSString stringWithFormat:@"a refused send ends the wait and is recorded (got %@)", refusedSend]);
    // If the wait times out before the drain before sending ends, the late drain is not sent and does not complete
    // again.
    view.hold=YES; view.held=nil; completed=0; received=YES; sent=0;
    NSString *timedOut = capturedRecords(^{
        webviewInputSendThen(view, @"pointerdown", 0.05, ^BOOL { sent++; return NO; },
            ^(BOOL value) { received=value; completed++; });
        eventWait(@"the input completes", ^BOOL { return completed > 0; });
    });
    check([timedOut containsString:@" error native webview input: receipt of pointerdown did not arrive within 0.05 seconds"],
        [NSString stringWithFormat:@"a timed-out wait is recorded with its type and limit (got %@)", timedOut]);
    check(view.held != nil, @"the pre-send drain is held");
    if (view.held) view.held();
    check(sent == 0 && completed == 1 && !received,
        [NSString stringWithFormat:@"a timed-out wait cancels its held pre-send drain (sent %lu, completed %lu)",
            (unsigned long)sent, (unsigned long)completed]);
    // A sent press whose receipt misses the limit records whether the document holds the receipt listener, and a receipt that
    // comes after the limit records its delay: a document without the listener, a document that never received the press, and a
    // late document are then told apart at the error level alone.
    view.hold=NO; view.held=nil; completed=0; received=YES;
    NSString *missed = capturedRecords(^{
        webviewInputSendThen(view, @"pointerdown", 0.05, ^BOOL { return YES; }, ^(BOOL value) { received=value; completed++; });
        eventWait(@"the input completes", ^BOOL { return completed > 0; });
    });
    // The listener question of the limit was sent to the web process before the late receipt, and the web process answers in
    // order on one connection: the answer of the late receipt comes after the answer of the listener and after the message of
    // the receipt.
    __block BOOL lateAnswered = NO;
    NSString *late = capturedRecords(^{
        postReceipt(view, ^{ lateAnswered = YES; });
        eventWait(@"the web process answers the late receipt", ^BOOL { return lateAnswered; });
    });
    NSString *both = [missed stringByAppendingString:late];
    check(!received && completed == 1, @"a sent press without a receipt in time completes as not received");
    check([missed containsString:@" error native webview input: receipt of pointerdown did not arrive within 0.05 seconds"]
        && [both containsString:@" error native webview input: the receipt listener of the document at the limit of pointerdown: present"],
        [NSString stringWithFormat:@"a missed receipt records the receipt listener of the document (got %@)", both]);
    check([late containsString:@" error native webview input: receipt of pointerdown arrived "]
        && [late containsString:@" ms after its wait ended at the limit"],
        [NSString stringWithFormat:@"a receipt after the limit records its delay (got %@)", late]);
    view.hold=YES;
    // If unregistering ends the wait, the late drain is not sent and does not complete again.
    view.held=nil; completed=0; received=YES; sent=0;
    webviewInputSendThen(view, @"pointerdown", 10, ^BOOL { sent++; return NO; },
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
