#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "window_controls_darwin.h"

// AppKit can reclaim its buttons when the recording indicator changes, even
// without resizing the window. Relayout the container when a button leaves it.
@interface SPWindowControls : NSView
@property(assign) NSView *home;
@property NSPoint position;
@property BOOL suspended;
- (void)place;
@end

@implementation SPWindowControls
- (void)willRemoveSubview:(NSView *)view {
    [super willRemoveSubview:view];
    self.needsLayout = YES;
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
    self.frame = NSMakeRect(self.position.x - a.origin.x,
        self.superview.bounds.size.height - self.position.y - NSMaxY(a),
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

static char controlsKey;

void windowPlaceControls(void *handle, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    SPWindowControls *controls = objc_getAssociatedObject(window, &controlsKey);
    if (!controls) {
        NSButton *close = [window standardWindowButton:NSWindowCloseButton];
        if (!close || !window.contentView) return;
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
    controls.position = NSMakePoint(x, y);
    [controls place];
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
