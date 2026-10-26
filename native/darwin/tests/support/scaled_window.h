// Test-only per-window backing scale control following WebKitTestRunner's AppKit procedure.
#import "private/appkit.h"

@interface SPScaledWindow : NSWindow
@end

@implementation SPScaledWindow
- (void)_adjustWindowResolution {}
@end

static void SPNotifyScaledWindowBackingChange(NSView *view) {
    [view viewDidChangeBackingProperties];
    for (NSView *child in view.subviews) SPNotifyScaledWindowBackingChange(child);
}

static void SPSetScaledWindowResolution(SPScaledWindow *window, CGFloat scale) {
    CGFloat old = window.backingScaleFactor;
    [window _setWindowResolution:scale];
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeBackingPropertiesNotification
        object:window userInfo:@{NSBackingPropertyOldScaleFactorKey: @(old)}];
    SPNotifyScaledWindowBackingChange(window.contentView);
}
