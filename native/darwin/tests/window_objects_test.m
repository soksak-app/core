// Checks with sp_window_objects_when that the live count of library objects attached to a window and webview grows
// when they are attached and returns to the initial value after the window and webview that were on screen are
// closed. The case in which the framework autoreleases the window while closing it is reproduced by autoreleasing one
// window, and events are handled with a loop that uses one autorelease pool per event, like [NSApp run] of AppKit.
// AppKit retains a window that was on screen until its close animation ends. The check does not activate the
// application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "webview_input.h"
#import "window_facts.h"
#import "window_objects.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSString *describe(sp_window_objects counts) {
    return [NSString stringWithFormat:@"{windowCompositions %ld, surfaceHosts %ld, inputRegistrations %ld}",
        counts.windowCompositions, counts.surfaceHosts, counts.inputRegistrations];
}

static BOOL same(sp_window_objects left, sp_window_objects right) {
    return left.windowCompositions == right.windowCompositions && left.surfaceHosts == right.surfaceHosts &&
        left.inputRegistrations == right.inputRegistrations;
}

typedef struct {
    int calls;
    BOOL mainThread;
    bool reached;
    sp_window_objects counts;
} SPCounted;

static void counted(void *context, const sp_window_objects *counts, bool reached) {
    SPCounted *state = context;
    state->calls++;
    state->mainThread = NSThread.isMainThread;
    state->reached = reached;
    state->counts = *counts;
}

// Handles events one by one until done is called. Uses one autorelease pool per event.
static void handleEventsUntilCounted(SPCounted *state) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
    while (state->calls == 0 && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:deadline inMode:NSDefaultRunLoopMode dequeue:YES];
            if (event) [NSApp sendEvent:event];
        }
    }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    sp_window_objects baseline = sp_window_objects_count();
    NSWindow *window;
    void *surface;
    WKWebView *attached;
    @autoreleasepool {
        window = [[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 600, 400)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        // The window that was on screen must be closed for the AppKit close animation to retain it. Puts it in front
        // without activating.
        [window orderFront:nil];
        window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        [window.contentView addSubview:main];
        check(sp_window_set_main_webview(window, main), @"the main webview is registered");
        check(webviewInputRegister(main), @"the main webview registers for input");
        surface = sp_surface_create(main);
        check(surface != NULL, @"a logical surface is created");
        attached = [[WKWebView alloc] initWithFrame:NSMakeRect(20, 20, 200, 120)];
        [window.contentView addSubview:attached positioned:NSWindowAbove relativeTo:nil];
        check(webviewInputRegister(attached), @"an attached surface webview registers for input");
        webviewAttachSurface(attached, main);
    }
    sp_window_objects open = sp_window_objects_count();
    sp_window_objects expected = {
        baseline.windowCompositions + 1, baseline.surfaceHosts + 2, baseline.inputRegistrations + 2,
    };
    check(same(open, expected), [NSString stringWithFormat:
        @"one window with a logical surface and an attached webview counts %@ (expected %@)", describe(open), describe(expected)]);

    SPCounted state = {0};
    // One event loop iteration of AppKit. Objects autoreleased while the window closes are released when this pool is
    // drained.
    @autoreleasepool {
        webviewInputUnregister(attached);
        webviewDetachSurface(attached);
        [attached removeFromSuperview];
        [attached release];
        sp_surface_close(surface);
        [window close];
        [[window retain] autorelease];
        [window release];
        sp_window_objects pending = sp_window_objects_count();
        check(pending.windowCompositions == expected.windowCompositions, [NSString stringWithFormat:
            @"an autoreleased window keeps its composition until its event iteration ends (%@)", describe(pending)]);
        sp_window_objects_when(&baseline, 10, counted, &state);
        NSEvent *event;
        do {
            event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:10]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (!event) break;
            [NSApp sendEvent:event];
        } while (event.type != NSEventTypeApplicationDefined || event.subtype == 0);
        check(event != nil, @"the posted event is delivered within 10 seconds");
        check(state.calls == 0, @"the counts are not read in the iteration that handles the posted event");
    }
    handleEventsUntilCounted(&state);
    check(state.calls == 1 && state.mainThread, [NSString stringWithFormat:
        @"the counts are given once on the main thread after the posted event (calls %d)", state.calls]);
    check(state.reached && same(state.counts, baseline), [NSString stringWithFormat:
        @"the closed window and its webviews return the counts to %@ (reached %d, counts %@)",
        describe(baseline), state.reached, describe(state.counts)]);

    SPCounted now = {0};
    sp_window_objects_when(NULL, 10, counted, &now);
    handleEventsUntilCounted(&now);
    check(now.calls == 1 && now.reached && same(now.counts, baseline), [NSString stringWithFormat:
        @"without expected counts the counts after the posted event are given (calls %d, reached %d, counts %@)",
        now.calls, now.reached, describe(now.counts)]);

    SPCounted missed = {0};
    sp_window_objects unreachable = {baseline.windowCompositions + 1, baseline.surfaceHosts, baseline.inputRegistrations};
    sp_window_objects_when(&unreachable, 0.2, counted, &missed);
    handleEventsUntilCounted(&missed);
    check(missed.calls == 1 && !missed.reached && same(missed.counts, baseline), [NSString stringWithFormat:
        @"counts that do not reach the expected counts within the bound are given as not reached (calls %d, reached %d, counts %@)",
        missed.calls, missed.reached, describe(missed.counts)]);
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
