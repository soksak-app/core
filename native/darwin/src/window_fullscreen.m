#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "window_fullscreen.h"
#import "observe.h"

// SPFullscreen waits for the full screen transition of one window. macOS ignores -toggleFullScreen: during
// a transition, so after the transition ends it toggles once more if the state differs from the requested one.
@interface SPFullscreen : NSObject
@property(nonatomic, assign) NSWindow *window;
@property(nonatomic) BOOL want;
@property(nonatomic) BOOL changing;
@property(nonatomic, copy) void (^done)(void);
- (void)request:(BOOL)on done:(void (^)(void))done;
@end

static char fullscreenKey;

static BOOL isFullscreen(NSWindow *window) {
    return (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
}

@implementation SPFullscreen
- (instancetype)initWithWindow:(NSWindow *)window {
    if ((self = [super init])) {
        _window = window;
        for (NSNotificationName name in @[NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification]) {
            sp_observe_notification_selector("window_fullscreen.settled", SP_OBSERVE_RECORD, self, @selector(settled:), name, window);
        }
        for (NSNotificationName name in @[NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification]) {
            sp_observe_notification_selector("window_fullscreen.started", SP_OBSERVE_RECORD, self, @selector(started:), name, window);
        }
    }
    return self;
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [_done release];
    [super dealloc];
}
- (void)started:(NSNotification *)notification {
    sp_observe_delivered("window_fullscreen.started");
    self.changing = YES;
}
- (void)settled:(NSNotification *)notification {
    sp_observe_delivered("window_fullscreen.settled");
    self.changing = NO;
    if (isFullscreen(self.window) != self.want) {
        // A request that arrived during the transition. Apply it now.
        [self.window toggleFullScreen:nil];
        return;
    }
    void (^done)(void) = [[self.done retain] autorelease];
    self.done = nil;
    if (done) done();
}
- (void)request:(BOOL)on done:(void (^)(void))done {
    self.want = on;
    // The wait of an earlier request ends. The state of the last request is the target.
    void (^waiting)(void) = [[self.done retain] autorelease];
    self.done = done;
    if (waiting) waiting();
    if (self.changing) return;
    if (isFullscreen(self.window) == on) {
        void (^ready)(void) = [[self.done retain] autorelease];
        self.done = nil;
        if (ready) ready();
        return;
    }
    [self.window toggleFullScreen:nil];
}
@end

bool sp_window_fullscreen(void *handle, bool on, void (^done)(void)) {
    NSCAssert(NSThread.isMainThread, @"full screen belongs to the main thread");
    NSWindow *window = (NSWindow *)handle;
    if (!window) return false;
    // Declares that the window can go full screen. The framework that created the window may not have set this.
    window.collectionBehavior |= NSWindowCollectionBehaviorFullScreenPrimary;
    SPFullscreen *state = objc_getAssociatedObject(window, &fullscreenKey);
    if (!state) {
        state = [[[SPFullscreen alloc] initWithWindow:window] autorelease];
        objc_setAssociatedObject(window, &fullscreenKey, state, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    [state request:on done:done];
    return true;
}
