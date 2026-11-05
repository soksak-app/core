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
@end

@implementation RecordingWindow
- (BOOL)isVisible { return self.onScreen; }
- (void)makeKeyAndOrderFront:(id)sender { [self.calls addObject:@"makeKeyAndOrderFront"]; }
- (void)makeKeyWindow { [self.calls addObject:@"makeKeyWindow"]; }
- (void)orderFront:(id)sender { [self.calls addObject:@"orderFront"]; }
- (void)orderFrontRegardless { [self.calls addObject:@"orderFrontRegardless"]; }
- (void)orderWindow:(NSWindowOrderingMode)place relativeTo:(NSInteger)other {
    [self.calls addObject:[NSString stringWithFormat:@"order %@ %ld", place == NSWindowAbove ? @"above" : @"below", (long)other]];
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

    if (failures) return 1;
    printf("window show: ok\n");
    return 0;
} }
