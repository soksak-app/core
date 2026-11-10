// Checks that the surface input monitor of a window answers from native state: a key down whose first responder is no surface
// enters no Go step, and one in a surface reports the press with one callback (docs/spec/hosts.md#main-thread-of-the-wails-host).
#import <Cocoa/Cocoa.h>
#include <stdio.h>
#include "host_api_input.h"
#include "host_callbacks.h"
#include "main_thread.h"
#include "webview_geometry.h"

#define STUB_V(result, name, parameters) static result stub_##name parameters {}
#define STUB_R(result, name, parameters) static result stub_##name parameters { return 0; }
#define STUB(mode, result, name, parameters, arguments) STUB_##mode(result, name, parameters)
SP_HOST_CALLBACKS(STUB)

static int failures;
static void check(BOOL passed, NSString *name) {
    fprintf(passed ? stdout : stderr, "%s: %s\n", passed ? "PASS" : "FAIL", name.UTF8String);
    if (!passed) failures++;
}

// Each entry of a callback into Go is one step on the worker, in which the main thread waits.
static int steps;
static void countedWorker(void (^task)(void)) {
    steps++;
    task();
}
static void runDirectly(void (^call)(void)) { call(); }

@interface SPMonitorResponder : NSView
@end
@implementation SPMonitorResponder
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event { (void)event; }
@end

static int stepsOfKeyDown(NSWindow *window) {
    NSEvent *key = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0
        windowNumber:window.windowNumber context:nil characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0];
    steps = 0;
    [NSApp sendEvent:key];
    return steps;
}

int main(void) { @autoreleasepool {
    sp_host_callbacks callbacks = {0};
#define ENTRY(mode, result, name, parameters, arguments) callbacks.name = stub_##name;
    SP_HOST_CALLBACKS(ENTRY)
#undef ENTRY
    if (sp_host_callbacks_install(&callbacks) != NULL) {
        fprintf(stderr, "FAIL: the callback table is not installed\n");
        return 1;
    }
    hostInstallMainThread(countedWorker, runDirectly);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 120)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 120)] autorelease];
    window.contentView = content;
    NSView *page = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 200, 120)] autorelease];
    [content addSubview:page];
    SPMonitorResponder *plain = [[[SPMonitorResponder alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)] autorelease];
    [page addSubview:plain];
    NSView *surface = (NSView *)sp_surface_create(content);
    check(surface != nil, @"a logical surface is created in the window");
    surface.hidden = NO;
    surface.frame = NSMakeRect(100, 0, 100, 120);
    SPMonitorResponder *inSurface = [[[SPMonitorResponder alloc] initWithFrame:NSMakeRect(0, 0, 50, 50)] autorelease];
    [surface addSubview:inSurface];
    uintptr_t monitor = surfaceWatchMouse((uintptr_t)window, 7);
    check(monitor != 0, @"the surface input monitor is installed");

    [window makeFirstResponder:plain];
    int plainSteps = stepsOfKeyDown(window);
    check(plainSteps == 0, [NSString stringWithFormat:
        @"a key down whose first responder is in no surface enters no Go step (%d steps)", plainSteps]);

    [window makeFirstResponder:inSurface];
    int surfaceSteps = stepsOfKeyDown(window);
    check(surfaceSteps == 1, [NSString stringWithFormat:
        @"a key down whose first responder is in a surface reports the press in one Go step (%d steps)", surfaceSteps]);

    surfaceUnwatchMouse(monitor);
    [window close];
    [window release];
    return failures == 0 ? 0 : 1;
} }
