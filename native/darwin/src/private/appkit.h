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
// The direction in which a press at a point of the window (window coordinates) resizes the window: 0 right, 1 top right, 2 top,
// 3 top left, 4 left, 5 bottom left, 6 bottom, 7 bottom right, and -1 for a point outside the resize edges. AppKit asks it in
// -[NSWindow _hitTestWithHysteresisCheck:forEvent:allowWindowDragging:] for each press, and a press at a direction enters the
// resize tracking of the window.
- (NSInteger)_resizeDirectionForMouseLocation:(NSPoint)location;
@end

@interface NSTextInputContext (SPPrivate)
// Gives a mouse event of a view to the input method of the context and calls completion with whether the input method handled
// it. WebKit makes the page event of a mouse event in the completion, which runs after the call has returned when the input method
// of the system serves the context.
- (void)handleEvent:(NSEvent *)event completionHandler:(void (^)(BOOL handled))completion;
@end
