// 등록과 수신 완료의 필수 마우스 처리 API 부재를 경계에서 주입한다.
#import <Cocoa/Cocoa.h>
#import "webview_input.h"
#import "private/webkit.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
/// The text that block writes to the standard error of the process.
static NSString *capturedStandardError(void (^block)(void)) {
    char path[] = "/tmp/webview_input_receipts_test.XXXXXX";
    int file = mkstemp(path);
    if (file < 0) { perror("mkstemp"); exit(1); }
    fflush(stderr);
    int saved = dup(STDERR_FILENO);
    if (saved < 0 || dup2(file, STDERR_FILENO) < 0) { perror("dup2"); exit(1); }
    block();
    fflush(stderr);
    if (dup2(saved, STDERR_FILENO) < 0) { perror("dup2"); exit(1); }
    close(saved);
    close(file);
    NSString *written = [NSString stringWithContentsOfFile:@(path) encoding:NSUTF8StringEncoding error:nil];
    unlink(path);
    return written ?: @"";
}
static void until(BOOL (^condition)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!condition() && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    if (!condition()) { fprintf(stderr, "FAIL: receipt fixture timed out\n"); exit(1); }
}

@interface SPReceiptView : WKWebView
@property(nonatomic) BOOL missingDrain;
@property(nonatomic) BOOL missingIgnore;
@property(nonatomic) NSUInteger drains;
// hold 이면 drain 콜백을 바로 실행하지 않고 held 에 보관한다. 시험이 원하는 시점에 실행한다.
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

// 별도 content world에서 수신 메시지를 주입한다. 실제 신뢰 입력 순서는 input_inject_test가 검증한다.
static void postReceipt(SPReceiptView *view) {
    [view evaluateJavaScript:@"webkit.messageHandlers.soksakInputReceipt.postMessage('pointerdown'); null"
        inFrame:nil inContentWorld:[WKContentWorld worldWithName:@"soksak-input"]
        completionHandler:^(id value, NSError *error) {
            if (error) { fprintf(stderr, "FAIL: injected receipt: %s\n", error.localizedDescription.UTF8String); exit(1); }
        }];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    SPReceiptView *view = [[[SPReceiptView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)] autorelease];
    view.missingDrain = YES;
    BOOL accepted = webviewInputRegister(view);
    check(!accepted, @"registration rejects an unavailable pending-mouse drain API");
    if (accepted) webviewInputUnregister(view);
    view.missingIgnore = YES;
    NSString *refused = capturedStandardError(^{ check(!webviewInputRegister(view), @"registration rejects an unavailable pointer tracking API"); });
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
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL { sent++; return NO; }, ^(BOOL value) { received=value; completed++; });
    until(^BOOL { return completed > 0; });
    check(sent == 0 && completed == 1 && !received, @"capability loss before delivery rejects without sending");
    view.missingDrain = NO;
    completed=0; received=YES; view.drains=0;
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL {
        view.missingDrain=YES; postReceipt(view); return YES;
    }, ^(BOOL value) { received=value; completed++; });
    until(^BOOL { return completed > 0; });
    check(!received && completed == 1 && view.drains == 1, @"capability loss after receipt never reports success");
    view.missingDrain=NO; completed=0; received=NO; view.drains=0;
    webviewInputSendThen(view, @"pointerdown", 1, ^BOOL {
        check(view.drains == 1, @"pending work drains before send"); postReceipt(view); return YES;
    }, ^(BOOL value) { received=value; completed++; });
    until(^BOOL { return completed > 0; });
    check(received && completed == 1 && view.drains == 2, @"successful receipt completes after the second drain");
    // 전송이 거부되면 대기를 실패로 끝내고 그 이유를 기록한다.
    view.hold=NO; view.held=nil; completed=0; received=YES;
    NSString *refusedSend = capturedStandardError(^{
        webviewInputSendThen(view, @"pointerdown", 1, ^BOOL { return NO; }, ^(BOOL value) { received=value; completed++; });
        until(^BOOL { return completed > 0; });
    });
    check(!received && completed == 1 && [refusedSend containsString:@" error native webview input: send of pointerdown was refused"],
        [NSString stringWithFormat:@"a refused send ends the wait and is recorded (got %@)", refusedSend]);
    // 전송 전 drain 이 끝나기 전에 대기가 시간 초과로 끝나면 늦은 drain 은 보내지 않고 다시 완료하지 않는다.
    view.hold=YES; view.held=nil; completed=0; received=YES; sent=0;
    NSString *timedOut = capturedStandardError(^{
        webviewInputSendThen(view, @"pointerdown", 0.05, ^BOOL { sent++; return NO; },
            ^(BOOL value) { received=value; completed++; });
        until(^BOOL { return completed > 0; });
    });
    check([timedOut containsString:@" error native webview input: receipt of pointerdown did not arrive within 0.05 seconds"],
        [NSString stringWithFormat:@"a timed-out wait is recorded with its type and limit (got %@)", timedOut]);
    check(view.held != nil, @"the pre-send drain is held");
    if (view.held) view.held();
    check(sent == 0 && completed == 1 && !received,
        [NSString stringWithFormat:@"a timed-out wait cancels its held pre-send drain (sent %lu, completed %lu)",
            (unsigned long)sent, (unsigned long)completed]);
    // 등록 해제가 대기를 끝내면 늦은 drain 도 보내지 않고 다시 완료하지 않는다.
    view.held=nil; completed=0; received=YES; sent=0;
    webviewInputSendThen(view, @"pointerdown", 10, ^BOOL { sent++; return NO; },
        ^(BOOL value) { received=value; completed++; });
    NSString *ended = capturedStandardError(^{ webviewInputUnregister(view); });
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
