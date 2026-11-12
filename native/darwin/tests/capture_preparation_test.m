// The capture asks the window server for the image of its windows through CGWindowListCreateImageFromArray, which the macOS 15
// SDK marks obsolete, so the capture looks it up at run time (docs/operations/private-native-apis.md). On a macOS without it, the
// open of a recording and a still fail with an error that names it, and they take nothing. With it, a window that is on screen
// opens, and a window that AppKit does not show fails with its number, also while the window server still lists it on screen
// after its close; a child window ordered out is not taken.
#import "../src/capture.m"
#include <dlfcn.h>
#import "support/temporary_folder.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSMutableArray<NSString *> *lookedUp;
// The lookup of a macOS that lacks the function; every other name resolves as it does.
static void *lookupWithoutWindowImage(void *handle, const char *name) {
    [lookedUp addObject:[NSString stringWithUTF8String:name]];
    return strcmp(name, "CGWindowListCreateImageFromArray") == 0 ? NULL : dlsym(handle, name);
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture preparation\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSString *directory = temporaryFolder(@"soksak-capture-preparation-");
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    // The window goes behind every window, as an application that is not active shows one (docs/spec/hosts.md#launch-activation).
    // AppKit keeps the order in the open Core Animation transaction of the thread until the run loop commits it, so the test
    // commits it, and the window server lists the window once the commit returns.
    [window orderBack:nil];
    [CATransaction flush];
    NSArray *listed = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)window.windowNumber)
        autorelease];
    check(listed.count == 1 && [listed[0][(id)kCGWindowIsOnscreen] boolValue] && listed[0][(id)kCGWindowBounds] != nil,
        [NSString stringWithFormat:@"the window server lists the ordered fixture window on screen with its bounds (%@)", listed]);

    const char *want = "CGWindowListCreateImageFromArray is not available on this macOS";
    lookedUp = [NSMutableArray array];
    captureLookup = lookupWithoutWindowImage;
    char *error = NULL;
    check(!sp_capture_open(window.windowNumber, false, &error) && error != NULL && strcmp(error, want) == 0,
        [NSString stringWithFormat:@"the open of a recording fails without the function (\"%s\")", error ?: ""]);
    free(error); error = NULL;
    NSString *still = [directory stringByAppendingPathComponent:@"still.png"];
    check(!sp_capture_still(window.windowNumber, still.fileSystemRepresentation, &error) && error != NULL && strcmp(error, want) == 0,
        [NSString stringWithFormat:@"a still fails without the function (\"%s\")", error ?: ""]);
    free(error); error = NULL;
    check(![NSFileManager.defaultManager fileExistsAtPath:still], @"a still without the function writes no file");
    check([lookedUp containsObject:@"CGWindowListCreateImageFromArray"], @"the capture looks the function up by its name");

    captureLookup = dlsym;
    check(sp_capture_open(window.windowNumber, false, &error) && error == NULL,
        [NSString stringWithFormat:@"a window on screen opens for a recording (%s)", error ?: ""]);
    free(error); error = NULL;
    NSWindow *closed = [[NSWindow alloc] initWithContentRect:NSMakeRect(140, 140, 80, 60)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    closed.releasedWhenClosed = NO;
    [closed orderBack:nil];
    [CATransaction flush];
    long number = closed.windowNumber;
    [closed close];
    [CATransaction flush];
    NSString *message = [NSString stringWithFormat:@"window %ld is not on screen", number];
    check(!sp_capture_open(number, false, &error) && error != NULL && [[NSString stringWithUTF8String:error] isEqual:message],
        [NSString stringWithFormat:@"a closed window does not open (\"%s\")", error ?: ""]);
    free(error); error = NULL;
    // A child window that the application ordered out is not taken with its window, also while the window server still lists it
    // on screen.
    NSWindow *child = [[NSWindow alloc] initWithContentRect:NSMakeRect(150, 150, 40, 30)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    child.releasedWhenClosed = NO;
    [window addChildWindow:child ordered:NSWindowAbove];
    [CATransaction flush];
    NSArray *withChild = resolveTarget(window.windowNumber, NO).windows;
    [child orderOut:nil];
    [CATransaction flush];
    NSArray *withoutChild = resolveTarget(window.windowNumber, NO).windows;
    check([withChild isEqual:(@[@(child.windowNumber), @(window.windowNumber)])]
        && [withoutChild isEqual:(@[@(window.windowNumber)])],
        [NSString stringWithFormat:@"a still takes a shown child window and not one ordered out (%@, then %@)", withChild, withoutChild]);
    if (child.parentWindow) [window removeChildWindow:child];
    [child close];
    [child release];
    [closed release];
    [window close];
    [window release];
    fprintf(stderr, "%s: native capture preparation (%.1fms)\n", failures ? "FAIL" : "PASS", (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
