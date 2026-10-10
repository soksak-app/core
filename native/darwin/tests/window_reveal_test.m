// Checks that a new window becomes opaque after the first load of the main webview and the following display have
// finished. Measures whether the still image of the revealed window has the color of the page and whether a window
// whose load failed is also revealed. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "capture.h"
#import "window_facts.h"
#import "window_reveal.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSWindow *makeWindow(WKWebView **webview) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
    [window.contentView addSubview:main];
    check(sp_window_set_main_webview(window, main), @"the main webview is registered");
    *webview = main;
    return window;
}

// Runs the run loop until the window becomes opaque. Stores the loading value at the time of the reveal in
// loadingAtReveal. It is NO if the window is not revealed within 10 seconds.
static BOOL waitRevealed(NSWindow *window, WKWebView *webview, BOOL *loadingAtReveal) {
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:10];
    while (window.alphaValue == 0 && limit.timeIntervalSinceNow > 0) {
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
        *loadingAtReveal = webview.loading;
    }
    return window.alphaValue == 1;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];

    NSWindow *bare = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [bare setReleasedWhenClosed:NO];
    char *error = NULL;
    check(!sp_window_reveal_after_load(bare, &error) && error && strcmp(error, "window reveal needs a registered main webview") == 0,
        @"a window without a registered main webview is rejected with its reason");
    free(error);
    check(bare.alphaValue == 1, @"a rejected window keeps its opacity");
    [bare close];
    [bare release];

    WKWebView *main = nil;
    NSWindow *window = makeWindow(&main);
    check(sp_window_reveal_after_load(window, &error) && error == NULL, @"a window with a registered main webview is prepared");
    check(window.alphaValue == 0, @"the prepared window is transparent before its page loads");
    [window orderFrontRegardless];
    [main loadHTMLString:@"<body style='margin:0;background:rgb(255,0,0)'></body>" baseURL:nil];
    BOOL loading = YES;
    check(waitRevealed(window, main, &loading), @"the window becomes opaque after its first load");
    check(!loading, @"the window becomes opaque only after the load ends");
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"window-reveal-%d", getpid()]];
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *still = [directory stringByAppendingPathComponent:@"revealed.png"];
    char *captureError = NULL;
    BOOL captured = sp_capture_still(window.windowNumber, still.fileSystemRepresentation, &captureError);
    check(captured, [NSString stringWithFormat:@"the revealed window is captured (%s)", captureError ? captureError : "no error"]);
    free(captureError);
    if (captured) {
        NSBitmapImageRep *image = [NSBitmapImageRep imageRepWithData:[NSData dataWithContentsOfFile:still]];
        // The lower center of the window is where the webview covers. Converts the sRGB color of the page to the
        // color space of the still image and compares in the same space.
        NSColor *seen = [image colorAtX:image.pixelsWide / 2 y:image.pixelsHigh * 3 / 4];
        NSColor *page = [[NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1] colorUsingColorSpace:seen.colorSpace];
        double distance = MAX(fabs(seen.redComponent - page.redComponent),
            MAX(fabs(seen.greenComponent - page.greenComponent), fabs(seen.blueComponent - page.blueComponent)));
        check(distance < 0.05, [NSString stringWithFormat:@"the revealed window shows its page (%@: seen %.3f %.3f %.3f, page %.3f %.3f %.3f)",
            seen.colorSpace.localizedName, seen.redComponent, seen.greenComponent, seen.blueComponent,
            page.redComponent, page.greenComponent, page.blueComponent]);
    }
    [NSFileManager.defaultManager removeItemAtPath:directory error:nil];
    [window close];
    [main release];
    [window release];

    WKWebView *failing = nil;
    NSWindow *failed = makeWindow(&failing);
    check(sp_window_reveal_after_load(failed, &error), @"a window whose load fails is prepared");
    [failed orderFrontRegardless];
    // A closed local port refuses the connection, so the load fails. A URL that is passed to another application is
    // not used.
    [failing loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"http://127.0.0.1:1/"]]];
    check(waitRevealed(failed, failing, &loading), @"a window whose first load fails becomes opaque and shows the failure");
    [failed close];
    [failing release];
    [failed release];
    return failures ? 1 : 0;
}}
