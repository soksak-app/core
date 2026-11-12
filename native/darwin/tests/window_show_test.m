#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <stdio.h>
#import <stdlib.h>
#import "window_reveal.h"

// What sp_window_show asks of a window for each state of the application. The window records the calls and orders
// nothing, so this check puts no window on the screen and activates nothing. window_show_order_test checks the place of
// a real window behind another application.

static int failures;

static void check(BOOL condition, NSString *what) {
    if (condition) return;
    fprintf(stderr, "FAIL: %s\n", what.UTF8String);
    failures++;
}

@interface RecordingWindow : NSWindow
@property BOOL onScreen;
@property(retain) NSMutableArray<NSString *> *calls;
// constrains tells that the order of the window moves it onto the screen, as AppKit constrains the frame of a window that it puts on
// the screen (constrainFrameRect:toScreen:), to constrained.
@property BOOL constrains;
@property NSRect constrained;
@end

@implementation RecordingWindow
- (BOOL)isVisible { return self.onScreen; }
- (void)ordered {
    if (self.constrains && !self.onScreen) [self setFrame:self.constrained display:NO];
}
- (void)makeKeyAndOrderFront:(id)sender { [self.calls addObject:@"makeKeyAndOrderFront"]; [self ordered]; }
- (void)makeKeyWindow { [self.calls addObject:@"makeKeyWindow"]; }
- (void)orderFront:(id)sender { [self.calls addObject:@"orderFront"]; [self ordered]; }
- (void)orderFrontRegardless { [self.calls addObject:@"orderFrontRegardless"]; [self ordered]; }
- (void)orderWindow:(NSWindowOrderingMode)place relativeTo:(NSInteger)other {
    [self.calls addObject:[NSString stringWithFormat:@"order %@ %ld", place == NSWindowAbove ? @"above" : @"below", (long)other]];
    [self ordered];
}
@end

// The state of the system that the function reads, in place of the real one.
static BOOL systemActive;
static NSArray<NSNumber *> *ownWindows;

static BOOL standInActive(id self, SEL command) { return systemActive; }
static NSArray<NSNumber *> *standInWindowNumbers(id self, SEL command, NSWindowNumberListOptions options) { return ownWindows; }
// The state that a virtual key window gives inside the application, which is not the state of the system.
static BOOL answersActive(id self, SEL command) { return YES; }

static void shown(BOOL active, BOOL onScreen, NSArray<NSNumber *> *(^others)(NSInteger self), NSArray<NSString *> *want, NSString *what) {
    RecordingWindow *window = [[RecordingWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES];
    window.releasedWhenClosed = NO;
    window.calls = [NSMutableArray array];
    window.onScreen = onScreen;
    systemActive = active;
    ownWindows = others(window.windowNumber);
    sp_window_show(window);
    check([window.calls isEqualToArray:want],
        [NSString stringWithFormat:@"%@: the calls are %@, want %@", what, window.calls, want]);
    [window release];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    method_setImplementation(class_getInstanceMethod(NSRunningApplication.class, @selector(isActive)), (IMP)standInActive);
    method_setImplementation(class_getClassMethod(NSWindow.class, @selector(windowNumbersWithOptions:)), (IMP)standInWindowNumbers);

    NSArray<NSNumber *> *(^none)(NSInteger) = ^NSArray<NSNumber *> *(NSInteger own) { return @[]; };
    NSArray<NSNumber *> *(^onlyItself)(NSInteger) = ^NSArray<NSNumber *> *(NSInteger own) { return @[@(own)]; };
    NSArray<NSNumber *> *(^another)(NSInteger) = ^NSArray<NSNumber *> *(NSInteger own) { return @[@(own), @42, @43]; };

    shown(YES, NO, none, @[@"makeKeyAndOrderFront"], @"an active application");
    shown(NO, NO, none, (@[@"order below 0", @"makeKeyWindow"]), @"the first window of an application that is not active");
    shown(NO, NO, another, (@[@"order above 42", @"makeKeyWindow"]), @"a window beside other windows of an application that is not active");
    shown(NO, YES, another, (@[@"order above 42", @"makeKeyWindow"]), @"a window on the screen beside other windows of an application that is not active");
    shown(NO, YES, onlyItself, @[@"makeKeyWindow"], @"the only window on the screen of an application that is not active");

    // A virtual key window makes NSApp answer as active, and the system still holds the application as not active.
    Method answers = class_getInstanceMethod(NSApplication.class, @selector(isActive));
    IMP real = method_setImplementation(answers, (IMP)answersActive);
    shown(NO, NO, none, (@[@"order below 0", @"makeKeyWindow"]), @"an application that only answers as active");
    method_setImplementation(answers, real);

    // A window that the host sized and moved before it shows goes on the screen with that frame, as a window that showed before its
    // move keeps it: the order that puts it on the screen would move it onto the screen. The frame reaches over the left and the top
    // edge of the screen, where a window that covers another at an edge of the screen stands.
    for (NSNumber *active in @[@YES, @NO]) {
        RecordingWindow *window = [[RecordingWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:YES];
        window.releasedWhenClosed = NO;
        window.calls = [NSMutableArray array];
        NSRect given = NSMakeRect(-100, 900, 1400, 860);
        [window setFrame:given display:NO];
        window.constrains = YES;
        window.constrained = NSMakeRect(0, 850, 1400, 860);
        systemActive = active.boolValue;
        ownWindows = @[@(window.windowNumber), @42];
        sp_window_show(window);
        check(NSEqualRects(window.frame, given), [NSString stringWithFormat:@"%@: the window showed with the frame %@, not the frame %@ that it was given",
            active.boolValue ? @"an active application" : @"an application that is not active",
            NSStringFromRect(window.frame), NSStringFromRect(given)]);
        [window release];
    }

    // A framework places a new window on the main screen, the display of the key window of the active application, which for an
    // application that is not active is a display of another application. sp_window_place_new centers the window in the work
    // area of the display of the frontmost other window of the application, and of the main screen when there is none. The
    // other window is on the last display, which on a machine with one display is the main screen too.
    NSScreen *last = NSScreen.screens.lastObject;
    check(last != nil, @"the check found no display");
    NSRect area = last.visibleFrame;
    // -initWithContentRect: moved a content rect on a display left of the main screen onto the main screen ({-1430, 559} came out
    // at {810, 559}), so the frame is set after the window is made, and the check reads that the window is on the last display.
    NSWindow *front = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 150)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    front.releasedWhenClosed = NO;
    [front setFrame:NSMakeRect(NSMinX(area) + 10, NSMinY(area) + 10, NSWidth(front.frame), NSHeight(front.frame)) display:NO];
    check(NSContainsRect(last.frame, front.frame), [NSString stringWithFormat:@"the other window of the check is on the last display %@ (%@)",
        NSStringFromRect(last.frame), NSStringFromRect(front.frame)]);
    struct { NSString *what; NSArray<NSNumber *> *others; NSScreen *screen; } placements[] = {
        {@"a new window beside another window of the application", @[@(front.windowNumber)], last},
        {@"the first window of the application", @[], NSScreen.mainScreen},
    };
    for (size_t i = 0; i < sizeof placements / sizeof placements[0]; i++) {
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 300, 200)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        [window setFrameOrigin:NSMakePoint(NSMinX(NSScreen.screens.firstObject.frame), NSMinY(NSScreen.screens.firstObject.frame))];
        ownWindows = [@[@(window.windowNumber)] arrayByAddingObjectsFromArray:placements[i].others];
        NSRect within = placements[i].screen.visibleFrame, frame = window.frame;
        NSPoint want = NSMakePoint(NSMinX(within) + floor((NSWidth(within) - NSWidth(frame)) / 2),
            NSMinY(within) + floor((NSHeight(within) - NSHeight(frame)) / 2));
        char *error = NULL;
        bool placed = sp_window_place_new(window, &error);
        check(placed, [NSString stringWithFormat:@"%@: the placement failed with %s", placements[i].what, error ? error : "no error"]);
        free(error);
        // The facts that the placement reads: the other windows that the application lists, the window that each number names
        // and its frame, the displays and the main screen, which the placement takes only when it finds no other window.
        NSMutableArray<NSString *> *read = [NSMutableArray array];
        for (NSNumber *number in placements[i].others) {
            NSWindow *named = [NSApp windowWithWindowNumber:number.integerValue];
            [read addObject:[NSString stringWithFormat:@"window %@ names %@ at %@", number, named ? NSStringFromClass(named.class) : @"nothing",
                named ? NSStringFromRect(named.frame) : @"-"]];
        }
        for (NSScreen *each in NSScreen.screens) [read addObject:[NSString stringWithFormat:@"display %@%@", NSStringFromRect(each.frame),
            each == NSScreen.mainScreen ? @" (main screen)" : @""]];
        check(NSEqualPoints(window.frame.origin, want), [NSString stringWithFormat:@"%@: the window is at %@, want %@, the center of the work area %@ (%@)",
            placements[i].what, NSStringFromPoint(window.frame.origin), NSStringFromPoint(want), NSStringFromRect(within),
            [read componentsJoinedByString:@"; "]]);
        check(!window.isVisible, [NSString stringWithFormat:@"%@: the placement put the window on the screen", placements[i].what]);
        [window release];
    }
    [front release];

    if (failures) return 1;
    printf("window show: ok\n");
    return 0;
} }
