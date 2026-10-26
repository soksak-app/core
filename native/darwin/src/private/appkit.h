// Private AppKit declarations that this library and its checks use.
// List and conditions of use: docs/operations/private-native-apis.md
#import <Cocoa/Cocoa.h>

@interface NSWindow (SPPrivate)
// Sets the title bar height (pt). It is passed to -[NSThemeFrame setCustomTitlebarHeight:], and AppKit uses the value to
// determine the title bar height, the content layout area, and the position of the window buttons. A value of 0 or less means there is no custom height.
- (void)setTitlebarHeight:(CGFloat)height;
// Check-only: WebKitTestRunner's window scale control. A caller owns scale-change notifications and view callbacks.
- (void)_setWindowResolution:(CGFloat)resolution;
- (void)_adjustWindowResolution;
@end
