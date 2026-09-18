#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "window_fullscreen.h"

// SPFullscreen 은 창 하나의 전체 화면 전환을 기다린다. macOS 는 전환 중에 -toggleFullScreen: 을
// 무시하므로, 전환이 끝난 뒤에 원하는 상태와 다르면 한 번 더 바꾼다.
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
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        for (NSNotificationName name in @[NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification]) {
            [center addObserver:self selector:@selector(settled:) name:name object:window];
        }
        for (NSNotificationName name in @[NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification]) {
            [center addObserver:self selector:@selector(started:) name:name object:window];
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
    self.changing = YES;
}
- (void)settled:(NSNotification *)notification {
    self.changing = NO;
    if (isFullscreen(self.window) != self.want) {
        // 전환 중에 들어온 요청이다. 이제 바꾼다.
        [self.window toggleFullScreen:nil];
        return;
    }
    void (^done)(void) = [[self.done retain] autorelease];
    self.done = nil;
    if (done) done();
}
- (void)request:(BOOL)on done:(void (^)(void))done {
    self.want = on;
    // 앞선 요청이 있으면 그 대기는 끝난다. 마지막 요청의 상태로 간다.
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
    // 전체 화면으로 갈 수 있는 창임을 알린다. 창을 만든 프레임워크가 정하지 않았을 수 있다.
    window.collectionBehavior |= NSWindowCollectionBehaviorFullScreenPrimary;
    SPFullscreen *state = objc_getAssociatedObject(window, &fullscreenKey);
    if (!state) {
        state = [[[SPFullscreen alloc] initWithWindow:window] autorelease];
        objc_setAssociatedObject(window, &fullscreenKey, state, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    [state request:on done:done];
    return true;
}
