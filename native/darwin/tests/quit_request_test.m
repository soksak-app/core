// Checks that the handler of sp_quit_request_install receives the operating system quit Apple event
// (kAEQuitApplication), reports the request on the main thread, and does not pass it to the delegate's
// applicationShouldTerminate:. The delegate imitates an application framework that answers cancel while windows save;
// a sender that reaches that path receives cancel. The event is sent through the handler delivery of the Apple event
// manager. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import "quit_request.h"
#import "support/records.h"
#import "event_ring.h"

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

// Sends a quit event to this process by its process identifier from a thread other than the main thread, and runs the main loop
// until the send returned and the request arrived, or five seconds passed. A send on the main thread is dispatched to the handler
// within the send, and the handler suspends the event, so that send ends with errAETimeout (-1712) although the request ran. From
// another thread the event goes through the event queue of the main thread, as the event of another process does, and the
// sender does not wait for the answer (kAENoReply). The Apple event manager names the sending process either way.
static OSStatus sendQuitToSelf(const int *requests, int before) {
    __block OSStatus status = 1;
    __block BOOL returned = NO;
    pid_t pid = getpid();
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSAppleEventDescriptor *target = [NSAppleEventDescriptor descriptorWithProcessIdentifier:pid];
        NSAppleEventDescriptor *event = [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass
            eventID:kAEQuitApplication targetDescriptor:target returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
        OSStatus sent = AESendMessage(event.aeDesc, NULL, kAENoReply, kAEDefaultTimeout);
        dispatch_async(dispatch_get_main_queue(), ^{
            status = sent;
            returned = YES;
        });
    });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while ((!returned || (status == noErr && *requests == before)) && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return status;
}

// Checks after [NSApp run] has installed the default handler, as in a real application.
static void runChecks(SPCancellingDelegate *delegate) {
    __block int requests = 0;
    __block BOOL requestOnMain = NO;
    __block BOOL installed = NO;
    __block int senderPid = -1;
    __block NSString *sender = nil;
    NSArray<NSDictionary *> *installing = capturedEvents(^{
        installed = sp_quit_request_install(^(int pid, const char *name) {
            requests++;
            requestOnMain = NSThread.isMainThread;
            senderPid = pid;
            [sender release];
            sender = name ? [[NSString alloc] initWithUTF8String:name] : nil;
        });
    });
    check(installed, @"the quit request handler installs once");
    check(installing.count == 1 && [installing[0][@"name"] isEqual:@"native.observe.registered"] && [installing[0][@"fields"][@"source"] isEqual:@"quit_request"]
        && [installing[0][@"fields"][@"kind"] isEqual:@"apple_event"], [NSString stringWithFormat:@"the installation is one registration event: %@", installing]);
    check(!sp_quit_request_install(^(int pid, const char *name) { (void)pid; (void)name; }), @"a second installation is rejected");

    __block OSErr result = noErr;
    NSArray<NSDictionary *> *quitting = capturedEvents(^{
        result = dispatchQuit(NULL);
        sp_quit_request_answer();
    });
    NSMutableArray<NSString *> *quitNames = [NSMutableArray array];
    for (NSDictionary *event in quitting) [quitNames addObject:[NSString stringWithFormat:@"%@:%@", event[@"name"], event[@"fields"][@"source"] ?: event[@"fields"][@"text"]]];
    check([quitNames isEqualToArray:@[@"native.observe.delivered:quit_request", @"native.record.info:the host answered the quit request"]],
        [NSString stringWithFormat:@"the quit request is one delivery and its answer is one record: %@", quitNames]);
    check(result == noErr, [NSString stringWithFormat:@"the handler accepts the quit event (%d)", result]);
    check(requests == 1 && requestOnMain, [NSString stringWithFormat:@"the request runs once on the main thread (%d)", requests]);
    check(senderPid == 0 && sender == nil,
          [NSString stringWithFormat:@"an event that names no sending process gives the sender 0 and no name (%d, %@)", senderPid, sender]);

    // A quit event that a process sends names that process, and the name of a running sender is its bundle identifier or name.
    // The requests before the send are the request of the dispatched event above; the send adds exactly one.
    int before = requests;
    OSStatus sent = sendQuitToSelf(&requests, before);
    sp_quit_request_answer();
    NSRunningApplication *current = NSRunningApplication.currentApplication;
    NSString *expected = current.bundleIdentifier ?: current.localizedName;
    check(sent == noErr && requests - before == 1 && senderPid == getpid() && [sender isEqual:expected],
          [NSString stringWithFormat:@"a sent quit event names its sender process and its name (want %d %@; status %d, requests of the send %d, sender %d %@)",
              getpid(), expected, (int)sent, requests - before, senderPid, sender]);
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
    // The records that this test reads include events below the level error, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
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
