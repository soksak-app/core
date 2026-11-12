// Checks that a new window becomes opaque after the first load of the main webview and the following display have
// finished. Measures whether the still image of the revealed window has the color of the page and whether a window
// whose load failed is also revealed. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "capture.h"
#import "surface_layout.h"
#import "window_facts.h"
#import "window_reveal.h"

@interface WKWebView (Presentation)
- (void)_doAfterNextPresentationUpdate:(void (^)(void))update;
@end

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

// Counts the refreshes of a screen and calls done after the given number of them.
@interface RefreshCount : NSObject
@property NSUInteger remaining;
@property (copy) void (^done)(void);
@end

@implementation RefreshCount
- (void)tick:(CADisplayLink *)link {
    if (--self.remaining > 0) return;
    // The link releases its target when it is invalidated, so the block is kept until it has run.
    void (^done)(void) = [[self.done retain] autorelease];
    [link invalidate];
    done();
}
- (void)dealloc {
    [_done release];
    [super dealloc];
}
@end

// Calls done on the main thread after count refreshes of screen.
static void afterRefreshes(NSScreen *screen, NSUInteger count, void (^done)(void)) {
    RefreshCount *refreshes = [[RefreshCount new] autorelease];
    refreshes.remaining = count;
    refreshes.done = done;
    // A link retains its target until it is invalidated.
    [[screen displayLinkWithTarget:refreshes selector:@selector(tick:)] addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

// Runs the run loop until the window becomes opaque, which the presentation update of the web view does. Stores the loading
// value at the time of the reveal in loadingAtReveal.
static BOOL waitRevealed(NSWindow *window, WKWebView *webview, BOOL *loadingAtReveal) {
    eventWait(@"the window becomes opaque", ^BOOL{
        *loadingAtReveal = webview.loading;
        return window.alphaValue != 0;
    });
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
    NSString *directory = temporaryFolder(@"soksak-window-reveal-");
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
    [window close];
    [main release];
    [window release];

    // A wait for the screen that shows the state of a window waits for the reveal: until then the window shows nothing.
    WKWebView *waiting = nil;
    NSWindow *unrevealed = makeWindow(&waiting);
    check(sp_window_reveal_after_load(unrevealed, &error), @"a window that a settled wait asks about is prepared");
    [unrevealed orderFrontRegardless];
    __block BOOL settled = NO;
    __block CGFloat alphaAtSettle = -1;
    surfaceLayoutAfterSettled(unrevealed, ^(void (^presented)(const char *)) { presented(NULL); }, ^(double displayed, const char *failure) {
        (void)displayed;
        (void)failure;
        settled = YES;
        alphaAtSettle = unrevealed.alphaValue;
    });
    // A settled wait that did not wait for the reveal would end at the first refresh of the screen after the next presentation of
    // the web view of the window. A presentation request made after the request of the wait ends after it, a block of the main
    // queue sent then runs after the block that the end of that request sent, and the second refresh after that block is after
    // the refresh that the wait would take, so the wait is judged there.
    __block BOOL pastSettle = NO;
    [waiting _doAfterNextPresentationUpdate:^{
        dispatch_async(dispatch_get_main_queue(), ^{
            afterRefreshes(unrevealed.screen ?: NSScreen.mainScreen, 2, ^{ pastSettle = YES; });
        });
    }];
    eventWait(@"two refreshes of the screen after the presentation that the settled wait asked for", ^BOOL{ return pastSettle; });
    check(!settled, @"a settled wait of a window that is not revealed does not end before the reveal");
    [waiting loadHTMLString:@"<body style='margin:0;background:rgb(0,0,255)'></body>" baseURL:nil];
    check(waitRevealed(unrevealed, waiting, &loading), @"the window that a settled wait asks about is revealed");
    eventWait(@"the settled wait of the revealed window ends", ^BOOL{ return settled; });
    check(settled && alphaAtSettle == 1,
        [NSString stringWithFormat:@"the settled wait of a window ends after its reveal (settled %d, alpha %.1f)", settled, alphaAtSettle]);
    [unrevealed close];
    [waiting release];
    [unrevealed release];

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
