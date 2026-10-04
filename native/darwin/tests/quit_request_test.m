// 운영체제의 종료 Apple event(kAEQuitApplication)를 sp_quit_request_install 의 처리기가 받아 메인 스레드에서 요청을
// 알리고, 위임자의 applicationShouldTerminate: 에 넘기지 않는지 검사한다. 위임자는 창이 저장하는 동안 취소를 답하는
// 애플리케이션 프레임워크를 흉내 내며, 그 경로를 지나면 보낸 쪽은 취소를 받는다. event 는 Apple event 관리자의
// 처리기 배달로 보낸다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "quit_request.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

@interface SPCancellingDelegate : NSObject <NSApplicationDelegate>
@property int terminateCalls;
@end
@implementation SPCancellingDelegate
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    (void)sender;
    self.terminateCalls++;
    return NSTerminateCancel;
}
@end

// 종료 event 를 설치된 처리기로 배달하고 처리기의 결과를 반환한다.
static OSErr dispatchQuit(void) {
    NSAppleEventDescriptor *event = [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass
        eventID:kAEQuitApplication targetDescriptor:[NSAppleEventDescriptor currentProcessDescriptor]
        returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    AppleEvent reply = {typeNull, NULL};
    // 처리기는 refCon 을 쓰지 않지만 인터페이스가 null 을 받지 않는다.
    static int refCon;
    OSErr result = [[NSAppleEventManager sharedAppleEventManager] dispatchRawAppleEvent:event.aeDesc
        withRawReply:&reply handlerRefCon:(SRefCon)&refCon];
    AEDisposeDesc(&reply);
    return result;
}

// 실제 애플리케이션처럼 [NSApp run] 이 기본 처리기를 설치한 뒤에 검사한다.
static void runChecks(SPCancellingDelegate *delegate) {
    __block int requests = 0;
    __block BOOL requestOnMain = NO;
    check(sp_quit_request_install(^{
        requests++;
        requestOnMain = NSThread.isMainThread;
    }), @"the quit request handler installs once");
    check(!sp_quit_request_install(^{ }), @"a second installation is rejected");

    OSErr result = dispatchQuit();
    check(result == noErr, [NSString stringWithFormat:@"the handler accepts the quit event (%d)", result]);
    check(requests == 1 && requestOnMain, [NSString stringWithFormat:@"the request runs once on the main thread (%d)", requests]);
    check(delegate.terminateCalls == 0,
          [NSString stringWithFormat:@"the quit event does not reach applicationShouldTerminate: (%d calls)", delegate.terminateCalls]);
    sp_quit_request_answer();
    sp_quit_request_answer();
    check(YES, @"the answer resumes the suspended event once and a later answer does nothing");
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    SPCancellingDelegate *delegate = [[[SPCancellingDelegate alloc] init] autorelease];
    NSApp.delegate = delegate;
    dispatch_async(dispatch_get_main_queue(), ^{
        runChecks(delegate);
        exit(failures ? 1 : 0);
    });
    [NSApp run];
    return 1;
}}
