#import <Cocoa/Cocoa.h>
#import "quit_request.h"

// 종료 event 를 보류하고 호스트에 알린다. 애플리케이션 프레임워크의 applicationShouldTerminate: 는 창이 저장하는 동안
// 취소를 답하므로, 운영체제의 종료 요청은 그 경로 대신 호스트의 종료 요청을 실행하고 끝나기 직전에 답한다.
@interface SPQuitRequest : NSObject
@property(copy) void (^request)(void);
@property(retain) NSMutableArray<NSValue *> *suspended;
- (void)handleQuit:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply;
@end

@implementation SPQuitRequest
- (void)handleQuit:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
    (void)event; (void)reply;
    NSAppleEventManagerSuspensionID suspension = [[NSAppleEventManager sharedAppleEventManager] suspendCurrentAppleEvent];
    if (suspension) [self.suspended addObject:[NSValue valueWithPointer:suspension]];
    self.request();
}
- (void)dealloc { [_request release]; [_suspended release]; [super dealloc]; }
@end

static SPQuitRequest *quitRequest;

bool sp_quit_request_install(void (^request)(void)) {
    NSCAssert(NSThread.isMainThread, @"quit request registration requires the AppKit thread");
    if (quitRequest) return false;
    quitRequest = [[SPQuitRequest alloc] init];
    quitRequest.request = request;
    quitRequest.suspended = [NSMutableArray array];
    [[NSAppleEventManager sharedAppleEventManager] setEventHandler:quitRequest
                                                       andSelector:@selector(handleQuit:withReplyEvent:)
                                                     forEventClass:kCoreEventClass
                                                        andEventID:kAEQuitApplication];
    return true;
}

void sp_quit_request_answer(void) {
    NSCAssert(NSThread.isMainThread, @"quit request answers require the AppKit thread");
    NSArray<NSValue *> *suspended = [[quitRequest.suspended copy] autorelease];
    [quitRequest.suspended removeAllObjects];
    for (NSValue *suspension in suspended) {
        [[NSAppleEventManager sharedAppleEventManager] resumeWithSuspensionID:suspension.pointerValue];
    }
}
