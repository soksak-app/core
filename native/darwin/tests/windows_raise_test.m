// The windows of the application stand at the check window level while sp_windows_raise holds them raised
// (diagnostics.windows.raise, docs/spec/endpoint.md#diagnostic-builds): a window at the normal level takes the level of the
// windows of the native checks, a window at another level keeps it, a window that sp_window_show shows while the state is on
// takes the level before it is ordered, and the end of the state lowers the windows that it raised and no other. The raise
// changes no activation, no key window and no frame, and orders no window. The windows record their calls and the check orders
// none of them itself, so it puts no window on the screen and activates nothing.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <stdio.h>
#import "support/check_level.h"
#import "window_reveal.h"

static int failures;

static void check(BOOL condition, NSString *what) {
    FILE *output = condition ? stdout : stderr;
    fprintf(output, "%s: %s\n", condition ? "PASS" : "FAIL", what.UTF8String);
    if (!condition) failures++;
}

// A window that records the calls that order it or make it key, with the level it stands at when it is ordered.
@interface RecordingWindow : NSWindow
@property(retain) NSMutableArray<NSString *> *calls;
@property NSWindowLevel orderedLevel;
@end

@implementation RecordingWindow
- (BOOL)isVisible { return NO; }
- (void)makeKeyAndOrderFront:(id)sender { [self.calls addObject:@"makeKeyAndOrderFront"]; self.orderedLevel = self.level; }
- (void)makeKeyWindow { [self.calls addObject:@"makeKeyWindow"]; }
- (void)orderFront:(id)sender { [self.calls addObject:@"orderFront"]; self.orderedLevel = self.level; }
- (void)orderFrontRegardless { [self.calls addObject:@"orderFrontRegardless"]; self.orderedLevel = self.level; }
- (void)orderWindow:(NSWindowOrderingMode)place relativeTo:(NSInteger)other {
    [self.calls addObject:@"orderWindow"];
    self.orderedLevel = self.level;
}
@end

static RecordingWindow *recordingWindow(NSWindowLevel level) {
    RecordingWindow *window = [[[RecordingWindow alloc] initWithContentRect:NSMakeRect(40, 40, 200, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES] autorelease];
    window.releasedWhenClosed = NO;
    window.calls = [NSMutableArray array];
    window.level = level;
    return window;
}

// The application is not active and shows no window, in place of the state of the system.
static BOOL standInActive(id self, SEL command) { return NO; }
static NSArray<NSNumber *> *standInWindowNumbers(id self, SEL command, NSWindowNumberListOptions options) { return @[]; }

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    method_setImplementation(class_getInstanceMethod(NSRunningApplication.class, @selector(isActive)), (IMP)standInActive);
    method_setImplementation(class_getClassMethod(NSWindow.class, @selector(windowNumbersWithOptions:)), (IMP)standInWindowNumbers);

    RecordingWindow *normal = recordingWindow(NSNormalWindowLevel);
    RecordingWindow *floating = recordingWindow(NSFloatingWindowLevel);
    // A window that stands at the check window level before the raise belongs to whoever put it there.
    RecordingWindow *placed = recordingWindow(kCheckWindowLevel);
    NSRect frame = normal.frame;
    BOOL active = NSApp.isActive;
    NSWindow *key = NSApp.keyWindow;

    sp_windows_raise(true);
    check(normal.level == kCheckWindowLevel, [NSString stringWithFormat:
        @"the raise sets a window at the normal level to the check window level (level %ld)", (long)normal.level]);
    check(floating.level == NSFloatingWindowLevel, [NSString stringWithFormat:
        @"the raise leaves a window at another level at its level (level %ld)", (long)floating.level]);
    check(normal.calls.count == 0 && floating.calls.count == 0 && placed.calls.count == 0, [NSString stringWithFormat:
        @"the raise orders no window and makes none key (calls %@, %@, %@)", normal.calls, floating.calls, placed.calls]);
    check(NSEqualRects(normal.frame, frame), [NSString stringWithFormat:
        @"the raise keeps the frame of the window (%@, was %@)", NSStringFromRect(normal.frame), NSStringFromRect(frame)]);
    check(NSApp.isActive == active && NSApp.keyWindow == key, @"the raise changes no activation and no key window");

    RecordingWindow *shown = recordingWindow(NSNormalWindowLevel);
    sp_window_show(shown);
    check(shown.calls.count > 0 && shown.orderedLevel == kCheckWindowLevel, [NSString stringWithFormat:
        @"a window shown while the windows are raised is ordered at the check window level (calls %@, level %ld)",
        shown.calls, (long)shown.orderedLevel]);

    sp_windows_raise(false);
    check(normal.level == NSNormalWindowLevel && shown.level == NSNormalWindowLevel, [NSString stringWithFormat:
        @"the end of the raise sets the windows that it raised to the normal level (levels %ld, %ld)",
        (long)normal.level, (long)shown.level]);
    check(placed.level == kCheckWindowLevel && floating.level == NSFloatingWindowLevel, [NSString stringWithFormat:
        @"the end of the raise leaves the windows that it did not raise at their levels (levels %ld, %ld)",
        (long)placed.level, (long)floating.level]);
    check(normal.calls.count == 0, [NSString stringWithFormat:@"the end of the raise orders no window (calls %@)", normal.calls]);

    RecordingWindow *later = recordingWindow(NSNormalWindowLevel);
    sp_window_show(later);
    check(later.calls.count > 0 && later.orderedLevel == NSNormalWindowLevel, [NSString stringWithFormat:
        @"a window shown after the raise ends is ordered at the normal level (calls %@, level %ld)",
        later.calls, (long)later.orderedLevel]);

    printf("%s\n", failures ? "FAIL: windows_raise_test" : "PASS: windows_raise_test");
    return failures ? 1 : 0;
} }
