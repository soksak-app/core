#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "window_fullscreen.h"
#import "observe.h"

typedef void (^SPFullscreenDone)(int result, const char *message);

// SPFullscreen waits for the full screen transition of one window. macOS ignores -toggleFullScreen: during
// a transition, so after the transition ends it toggles once more if the state differs from the requested one.
@interface SPFullscreen : NSObject
@property(nonatomic, assign) NSWindow *window;
@property(nonatomic) BOOL want;
@property(nonatomic) BOOL changing;
@property(nonatomic, copy) SPFullscreenDone done;
- (void)request:(BOOL)on done:(SPFullscreenDone)done;
- (void)failed;
@end

static char fullscreenKey;

static BOOL isFullscreen(NSWindow *window) {
    return (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
}

// refusal is the cause for which macOS does not start a transition of window, or NULL. macOS ignores -toggleFullScreen: of
// such a window and sends no notification, so the request is refused in its turn.
static const char *refusal(NSWindow *window) {
    if (window.isMiniaturized) return "the window is minimized";
    if (!window.isVisible) return "the window is not shown";
    if (window.attachedSheet) return "the window shows a sheet";
    return NULL;
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
        sp_observe_notification_selector("window_fullscreen.closed", SP_OBSERVE_RECORD, self, @selector(closed:),
            NSWindowWillCloseNotification, window);
    }
    return self;
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [_done release];
    [super dealloc];
}
// answer answers the waiting request once with result and message.
- (void)answer:(int)result message:(const char *)message {
    SPFullscreenDone done = [[self.done retain] autorelease];
    self.done = nil;
    if (done) done(result, message);
}
// toggle starts the transition to the wanted state. macOS posts the will-enter or will-exit notification in the turn of the
// toggle, so a toggle after which no transition runs is one that macOS did not start.
- (void)toggle {
    [self.window toggleFullScreen:nil];
    if (!self.changing && isFullscreen(self.window) != self.want) {
        [self answer:SP_FULLSCREEN_REFUSED message:"macOS did not start the full screen transition"];
    }
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
        [self toggle];
        return;
    }
    [self answer:SP_FULLSCREEN_DONE message:NULL];
}
- (void)closed:(NSNotification *)notification {
    sp_observe_delivered("window_fullscreen.closed");
    self.changing = NO;
    [self answer:SP_FULLSCREEN_CLOSED message:"the window closed during the full screen transition"];
}
// failed is a started transition that macOS failed. AppKit reports it only to the delegate of the window.
- (void)failed {
    self.changing = NO;
    [self answer:SP_FULLSCREEN_FAILED message:"macOS failed the full screen transition"];
}
- (void)request:(BOOL)on done:(SPFullscreenDone)done {
    const char *refused = refusal(self.window);
    if (refused) {
        done(SP_FULLSCREEN_REFUSED, refused);
        return;
    }
    self.want = on;
    // The wait of an earlier request ends. The state of the last request is the target.
    [self answer:SP_FULLSCREEN_REFUSED message:"a later full screen request replaced the request"];
    self.done = done;
    if (self.changing) return;
    if (isFullscreen(self.window) == on) {
        [self answer:SP_FULLSCREEN_DONE message:NULL];
        return;
    }
    [self toggle];
}
@end

// The failure of a full screen transition reaches only the delegate of the window, which the framework owns. The host adds
// its handling to the class of that delegate: the method of the class, or the one it inherits, runs first, and then the
// SPFullscreen of the window hears the failure.
static void fullscreenFailed(NSWindow *window) {
    SPFullscreen *state = objc_getAssociatedObject(window, &fullscreenKey);
    [state failed];
}

static void hearFailure(Class delegateClass, SEL selector) {
    static NSMutableSet<NSString *> *heard;
    if (!heard) heard = [[NSMutableSet alloc] init];
    NSString *key = [NSString stringWithFormat:@"%s %s", class_getName(delegateClass), sel_getName(selector)];
    if ([heard containsObject:key]) return;
    [heard addObject:key];
    typedef void (*Handler)(id, SEL, NSWindow *);
    unsigned int count = 0;
    Method *methods = class_copyMethodList(delegateClass, &count);
    Method own = NULL;
    for (unsigned int i = 0; i < count; i++) {
        if (method_getName(methods[i]) == selector) own = methods[i];
    }
    free(methods);
    if (own) {
        Handler original = (Handler)method_getImplementation(own);
        method_setImplementation(own, imp_implementationWithBlock(^(id delegate, NSWindow *window) {
            original(delegate, selector, window);
            fullscreenFailed(window);
        }));
        return;
    }
    Class superclass = class_getSuperclass(delegateClass);
    Handler inherited = superclass && [superclass instancesRespondToSelector:selector]
        ? (Handler)class_getMethodImplementation(superclass, selector) : NULL;
    class_addMethod(delegateClass, selector, imp_implementationWithBlock(^(id delegate, NSWindow *window) {
        if (inherited) inherited(delegate, selector, window);
        fullscreenFailed(window);
    }), "v@:@");
}

bool sp_window_fullscreen(void *handle, bool on, void (^done)(int result, const char *message)) {
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
    if (window.delegate) {
        hearFailure(object_getClass(window.delegate), @selector(windowDidFailToEnterFullScreen:));
        hearFailure(object_getClass(window.delegate), @selector(windowDidFailToExitFullScreen:));
    }
    [state request:on done:done];
    return true;
}
