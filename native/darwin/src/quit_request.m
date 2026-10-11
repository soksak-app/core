#import <Cocoa/Cocoa.h>
#import "quit_request.h"
#import "application_log.h"
#import "observe.h"

// Holds the quit event and notifies the host. applicationShouldTerminate: of the application framework replies cancel
// while windows are saving, so the quit request of the operating system runs the quit request of the host instead of that path and replies just before the host ends.
@interface SPQuitRequest : NSObject
@property(copy) void (^request)(void);
@property(retain) NSMutableArray<NSValue *> *suspended;
@property(retain) NSMutableArray<NSAppleEventDescriptor *> *replies;
- (void)handleQuit:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply;
@end

@implementation SPQuitRequest
- (void)handleQuit:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
    (void)event;
    sp_observe_delivered("quit_request");
    NSAppleEventManagerSuspensionID suspension = [[NSAppleEventManager sharedAppleEventManager] suspendCurrentAppleEvent];
    if (suspension) {
        [self.suspended addObject:[NSValue valueWithPointer:suspension]];
        [self.replies addObject:reply];
    }
    self.request();
}
- (void)dealloc { [_request release]; [_suspended release]; [_replies release]; [super dealloc]; }
@end

static SPQuitRequest *quitRequest;

bool sp_quit_request_install(void (^request)(void)) {
    NSCAssert(NSThread.isMainThread, @"quit request registration requires the AppKit thread");
    if (quitRequest) return false;
    quitRequest = [[SPQuitRequest alloc] init];
    quitRequest.request = request;
    quitRequest.suspended = [NSMutableArray array];
    quitRequest.replies = [NSMutableArray array];
    if (!sp_observe_apple_event("quit_request", SP_OBSERVE_RECORD, quitRequest, @selector(handleQuit:withReplyEvent:), kCoreEventClass, kAEQuitApplication)) {
        [quitRequest release];
        quitRequest = nil;
        return false;
    }
    return true;
}

// Resumes every suspended event; with an error, the reply of each carries it first.
static void resumeSuspended(OSErr error) {
    NSArray<NSValue *> *suspended = [[quitRequest.suspended copy] autorelease];
    NSArray<NSAppleEventDescriptor *> *replies = [[quitRequest.replies copy] autorelease];
    [quitRequest.suspended removeAllObjects];
    [quitRequest.replies removeAllObjects];
    for (NSUInteger index = 0; index < suspended.count; index++) {
        if (error != noErr) {
            [replies[index] setParamDescriptor:[NSAppleEventDescriptor descriptorWithInt32:error] forKeyword:keyErrorNumber];
        }
        [[NSAppleEventManager sharedAppleEventManager] resumeWithSuspensionID:suspended[index].pointerValue];
    }
}

void sp_quit_request_answer(void) {
    NSCAssert(NSThread.isMainThread, @"quit request answers require the AppKit thread");
    sp_log_info("quit request", "the host answered the quit request");
    resumeSuspended(noErr);
}

void sp_quit_request_cancel(void) {
    NSCAssert(NSThread.isMainThread, @"quit request answers require the AppKit thread");
    sp_log_info("quit request", "the host cancelled the quit request");
    resumeSuspended(userCanceledErr);
}
