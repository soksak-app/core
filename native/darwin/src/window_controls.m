#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "window_controls.h"

// AppKit takes its buttons back into the title bar when the window title or
// the recording indicator changes (-[NSThemeFrame _updateButtons]), even without
// a resize. The container puts them back in a run loop block, which runs before
// the next display pass; waiting for the next layout pass let the title bar
// position reach the screen.
@interface SPWindowControls : NSView
@property(assign) NSView *home;
@property CGFloat left;
@property CGFloat centre;
@property BOOL suspended;
@property BOOL returning;
- (void)place;
@end

static char controlsKey;

@implementation SPWindowControls
- (void)willRemoveSubview:(NSView *)view {
    [super willRemoveSubview:view];
    if (self.suspended || self.returning || !self.window) return;
    self.returning = YES;
    // 블록은 뷰나 창을 붙잡지 않는다. 그 사이에 창이 닫혀 해제되면 뷰가 가리키는 창도 사라지므로,
    // 실행할 때 창 번호로 창을 다시 찾는다.
    NSInteger number = self.window.windowNumber;
    CFRunLoopRef main = CFRunLoopGetMain();
    CFRunLoopPerformBlock(main, kCFRunLoopCommonModes, ^{
        NSWindow *window = [NSApp windowWithWindowNumber:number];
        SPWindowControls *controls = window ? objc_getAssociatedObject(window, &controlsKey) : nil;
        if (!controls) return;
        controls.returning = NO;
        [controls place];
    });
    CFRunLoopWakeUp(main);
}
- (void)layout {
    [super layout];
    [self place];
}
- (void)place {
    NSWindow *window = self.window;
    if (!window || self.suspended) return;
    NSButton *first = [window standardWindowButton:NSWindowCloseButton];
    NSButton *last = [window standardWindowButton:NSWindowZoomButton];
    if (!first || !last) return;
    for (NSUInteger kind = NSWindowCloseButton; kind <= NSWindowZoomButton; kind++) {
        NSButton *button = [window standardWindowButton:kind];
        if (button && button.superview != self) [self addSubview:button];
    }
    NSRect a = first.frame, b = last.frame;
    // 단추가 보이는 영역은 프레임보다 작고 프레임 안에서 위아래 여백이 다르다. 보이는 영역의
    // 세로 중앙을 centre 에 맞춘다. 이 뷰는 뒤집히지 않았으므로 y 는 위로 증가한다.
    NSRect drawn = [self convertRect:[first alignmentRectForFrame:first.bounds] fromView:first];
    CGFloat drawnTop = NSMaxY(a) - NSMaxY(drawn);
    CGFloat top = self.centre - drawnTop - NSHeight(drawn) / 2;
    self.frame = NSMakeRect(self.left - a.origin.x,
        self.superview.bounds.size.height - top - NSMaxY(a),
        NSMaxX(b) + a.origin.x, NSMaxY(a) + a.origin.y);
}
- (void)windowResized:(NSNotification *)note { [self place]; }
- (void)enterFullScreen:(NSNotification *)note {
    self.suspended = YES;
    for (NSUInteger kind = NSWindowCloseButton; kind <= NSWindowZoomButton; kind++) {
        NSButton *button = [self.window standardWindowButton:kind];
        if (button) [self.home addSubview:button];
    }
}
- (void)exitFullScreen:(NSNotification *)note {
    self.suspended = NO;
    [self place];
}
- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [super dealloc];
}
@end


bool windowPlaceControls(void *handle, double x, double centreY) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    SPWindowControls *controls = objc_getAssociatedObject(window, &controlsKey);
    if (!controls) {
        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        if (!close || !window.contentView) return false;
        controls = [[[SPWindowControls alloc] initWithFrame:NSZeroRect] autorelease];
        controls.home = close.superview;
        [window.contentView addSubview:controls positioned:NSWindowAbove relativeTo:nil];
        objc_setAssociatedObject(window, &controlsKey, controls, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        window.contentView.postsFrameChangedNotifications = YES;
        [center addObserver:controls selector:@selector(windowResized:) name:NSViewFrameDidChangeNotification object:window.contentView];
        [center addObserver:controls selector:@selector(enterFullScreen:) name:NSWindowWillEnterFullScreenNotification object:window];
        [center addObserver:controls selector:@selector(exitFullScreen:) name:NSWindowDidExitFullScreenNotification object:window];
    }
    controls.left = x;
    controls.centre = centreY;
    [controls place];
    return true;
}

// Reading a position must not repair it: callers need the actual geometry.
void windowControls(void *handle, double *out) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    NSView *content = window.contentView;
    NSRect together = NSZeroRect;
    for (NSUInteger kind = NSWindowCloseButton; kind <= NSWindowZoomButton; kind++) {
        NSButton *button = [window standardWindowButton:kind];
        if (!button || button.isHiddenOrHasHiddenAncestor) continue;
        NSRect drawn = [button alignmentRectForFrame:button.bounds];
        NSRect at = [content convertRect:drawn fromView:button];
        together = NSIsEmptyRect(together) ? at : NSUnionRect(together, at);
    }
    if (NSIsEmptyRect(together)) return;
    out[0] = together.origin.x;
    out[1] = content.bounds.size.height - NSMaxY(together);
    out[2] = together.size.width;
    out[3] = together.size.height;
}
