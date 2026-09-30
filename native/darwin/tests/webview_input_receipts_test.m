// 등록과 수신 완료의 필수 마우스 처리 API 부재를 경계에서 주입한다.
#import <Cocoa/Cocoa.h>
#import "webview_input.h"
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

@interface SPReceiptView : WKWebView
@property(nonatomic) BOOL missingDrain;
@property(nonatomic) NSUInteger drains;
@end
@implementation SPReceiptView
- (BOOL)respondsToSelector:(SEL)selector {
    if (selector == @selector(_doAfterProcessingAllPendingMouseEvents:) && self.missingDrain) return NO;
    return [super respondsToSelector:selector];
}
- (void)_doAfterProcessingAllPendingMouseEvents:(void (^)(void))done { self.drains++; done(); }
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
    webviewInputUnregister(view);
    check(!NSApp.isActive, @"receipt capability checks remain inactive");
    return failures ? 1 : 0;
}}
