#import <Cocoa/Cocoa.h>
#import "window_controls.h"
#import "private/appkit.h"

// AppKit owns the window buttons. When a button is moved to another view, AppKit takes it back when the
// title or the recording indicator changes (-[NSThemeFrame _updateButtons]), and while it is restored the
// button disappears or a frame with the button pulled into the title bar position appears on screen
// (measured: 1 to 2 frames per 48 window moves and resizes). Instead, set the title bar height so that
// AppKit places the buttons at the vertical center of that height.

// A window that cannot have a title bar has no standard buttons or content view.
static BOOL titled(NSWindow *window) {
    return [window standardWindowButton:NSWindowCloseButton] && window.contentView;
}

double windowTitlebarHeight(void *handle) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    // 0 is the height of a window without a title bar (full screen), so a window that cannot have a
    // title bar gives -1.
    if (!titled(window)) return -1;
    return window.frame.size.height - window.contentLayoutRect.size.height;
}

// setTitlebarHeight: of AppKit is not in the SDK headers (docs/operations/private-native-apis.md). A value
// of 0 or less clears the custom height without laying out again, so it is not accepted. Full screen
// transitions save the value on entry and restore it on exit, so a value set during full screen is lost on
// exit and the title bar is not visible meanwhile. In that case the call succeeds without changing the
// height. The caller learns that state from the 0 of windowTitlebarHeight, and the page prepares the rows
// again after the window exits full screen.
bool windowSetTitlebarHeight(void *handle, double height, char **failure) {
    NSCAssert(NSThread.isMainThread, @"Window controls belong to the main thread");
    NSWindow *window = (NSWindow *)handle;
    *failure = NULL;
    if (!isfinite(height) || height <= 0) {
        *failure = strdup("title bar height must be a positive finite number");
        return false;
    }
    if (!titled(window)) {
        *failure = strdup("the window has no standard buttons or content view for a title bar");
        return false;
    }
    if (window.styleMask & NSWindowStyleMaskFullScreen) return true;
    [window setTitlebarHeight:height];
    [window layoutIfNeeded];
    return true;
}

// Reading the position does not correct the position. The caller needs the actual geometry.
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
