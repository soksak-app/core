// Checks that the handler of sp_quit_request_install receives the operating system quit Apple event
// (kAEQuitApplication), reports the request on the main thread, and does not pass it to the delegate's
// applicationShouldTerminate:. The delegate imitates an application framework that answers cancel while windows save;
// a sender that reaches that path receives cancel. The event is sent through the handler delivery of the Apple event
// manager. The check does not activate the application.
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

// Delivers a quit event to the installed handler and returns the handler result. If replyOut is not NULL, creates a
// reply event as if the sender required an answer, passes it to the handler, and returns it at that location; the
// caller releases it with AEDisposeDesc.
static OSErr dispatchQuit(AppleEvent *replyOut) {
    NSAppleEventDescriptor *event = [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass
        eventID:kAEQuitApplication targetDescriptor:[NSAppleEventDescriptor currentProcessDescriptor]
        returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    AppleEvent reply = {typeNull, NULL};
    if (replyOut) {
        NSAppleEventDescriptor *sender = [NSAppleEventDescriptor currentProcessDescriptor];
        AECreateAppleEvent(kCoreEventClass, kAEAnswer, sender.aeDesc, kAutoGenerateReturnID, kAnyTransactionID, &reply);
    }
    // The handler does not use refCon, but the interface does not accept null.
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

// Checks after [NSApp run] has installed the default handler, as in a real application.
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
