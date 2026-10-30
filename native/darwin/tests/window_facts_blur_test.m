// Checks that the window facts report the native blur filter of each web view as a JSON boolean `blurred`, which the hosts
// read into the `blurred` of each document of host.window (docs/spec/native-surfaces.md#regions, docs/spec/host-contract.md).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

/** The value of `blurred` in the window facts row of view, as JSON parses it. */
static id blurredOf(NSWindow *window, WKWebView *view) {
    char *json = sp_window_facts(window);
    NSDictionary *facts = json ? [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)]
        options:0 error:nil] : nil;
    free(json);
    for (NSDictionary *row in facts[@"webviews"])
        if ([row[@"view"] unsignedLongLongValue] == (uintptr_t)view) return row[@"blurred"];
    return nil;
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp finishLaunching];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
        [window.contentView addSubview:main];
        check(sp_window_set_main_webview(window, main), @"the main page web view is registered");
        WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(10, 10, 200, 100)] autorelease];
        [window.contentView addSubview:view];
        [window orderBack:nil];

        id before = blurredOf(window, view);
        check(before == (id)kCFBooleanFalse, [NSString stringWithFormat:
            @"a web view without a filter reports blurred as the JSON boolean false: %@ (%@)", before, [before class]]);
        sp_document_background(view, true);
        id blurred = blurredOf(window, view);
        check(blurred == (id)kCFBooleanTrue, [NSString stringWithFormat:
            @"a web view with the blur filter reports blurred as the JSON boolean true: %@ (%@)", blurred, [blurred class]]);
        sp_document_background(view, false);
        id after = blurredOf(window, view);
        check(after == (id)kCFBooleanFalse, [NSString stringWithFormat:
            @"a web view whose filter is removed reports blurred as the JSON boolean false: %@ (%@)", after, [after class]]);
        [window close];
        [window release];
    }
    fprintf(stdout, "%s: window_facts_blur_test\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
