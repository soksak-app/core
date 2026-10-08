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

// 종료 event 를 설치된 처리기로 배달하고 처리기의 결과를 반환한다. replyOut 이 NULL 이 아니면 보낸 쪽이 답을 요구하는
// 것처럼 답 event 를 만들어 처리기에 넘기고 그 위치에 돌려주며, 호출자가 AEDisposeDesc 로 해제한다.
static OSErr dispatchQuit(AppleEvent *replyOut) {
    NSAppleEventDescriptor *event = [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass
        eventID:kAEQuitApplication targetDescriptor:[NSAppleEventDescriptor currentProcessDescriptor]
        returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    AppleEvent reply = {typeNull, NULL};
    if (replyOut) {
        NSAppleEventDescriptor *sender = [NSAppleEventDescriptor currentProcessDescriptor];
        AECreateAppleEvent(kCoreEventClass, kAEAnswer, sender.aeDesc, kAutoGenerateReturnID, kAnyTransactionID, &reply);
    }
    // 처리기는 refCon 을 쓰지 않지만 인터페이스가 null 을 받지 않는다.
    static int refCon;
    OSErr result = [[NSAppleEventManager sharedAppleEventManager] dispatchRawAppleEvent:event.aeDesc
        withRawReply:&reply handlerRefCon:(SRefCon)&refCon];
    if (replyOut) *replyOut = reply; else AEDisposeDesc(&reply);
    return result;
}

// The error number of a reply event; 0 when the reply carries none.
static OSErr replyError(const AppleEvent *reply) {
    SInt32 error = 0;
    AEGetParamPtr(reply, keyErrorNumber, typeSInt32, NULL, &error, sizeof error, NULL);
    return (OSErr)error;
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

    OSErr result = dispatchQuit(NULL);
    check(result == noErr, [NSString stringWithFormat:@"the handler accepts the quit event (%d)", result]);
    check(requests == 1 && requestOnMain, [NSString stringWithFormat:@"the request runs once on the main thread (%d)", requests]);
    check(delegate.terminateCalls == 0,
          [NSString stringWithFormat:@"the quit event does not reach applicationShouldTerminate: (%d calls)", delegate.terminateCalls]);
    sp_quit_request_answer();
    sp_quit_request_answer();
    check(YES, @"the answer resumes the suspended event once and a later answer does nothing");

    // A request that the sender wants answered is answered without an error when the application answers it, and with
    // userCanceledErr when the application cancels it because a window keeps a modified tab.
    AppleEvent answeredReply = {typeNull, NULL};
    check(dispatchQuit(&answeredReply) == noErr, @"the handler accepts a quit event that wants an answer");
    sp_quit_request_answer();
    check(replyError(&answeredReply) == noErr, [NSString stringWithFormat:@"an answered request carries no error (%d)", replyError(&answeredReply)]);
    AEDisposeDesc(&answeredReply);
    AppleEvent cancelledReply = {typeNull, NULL};
    check(dispatchQuit(&cancelledReply) == noErr, @"the handler accepts a second quit event that wants an answer");
    sp_quit_request_cancel();
    sp_quit_request_cancel();
    check(replyError(&cancelledReply) == userCanceledErr,
          [NSString stringWithFormat:@"a cancelled request carries userCanceledErr (%d)", replyError(&cancelledReply)]);
    AEDisposeDesc(&cancelledReply);
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
