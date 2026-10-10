// Checks that when the page creates a title bar with the requested height, AppKit places the window buttons at the
// vertical center of that height, and that the position holds after a title change and a window resize. The check
// does not activate the application.
#import <Cocoa/Cocoa.h>
#import "window_controls.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// A window like the windows of both hosts: the title bar is hidden and the content fills the whole window. It has no
// toolbar.
static NSWindow *hostLikeWindow(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 400)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    return window;
}

// Checks that both the title bar height measured as the difference between the window frame and the content layout
// area and windowTitlebarHeight equal row, and that the margins above and below the button are equal within one
// device pixel. AppKit snaps the button to device pixels, so if the remaining height is an odd number of pixels, the
// top and bottom differ by one pixel (1 / backingScaleFactor pt).
static void expectCentred(NSWindow *window, double row, NSString *when) {
    double bar = window.frame.size.height - window.contentLayoutRect.size.height;
    double reported = windowTitlebarHeight(window);
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    double above = area[1];
    double below = row - (area[1] + area[3]);
    double pixel = 1 / window.backingScaleFactor;
    check(bar == row && reported == row && area[3] > 0 && fabs(above - below) <= pixel,
        [NSString stringWithFormat:@"%@: the buttons are centred within one device pixel in the %.1fpt title bar "
            "(title bar %.1f, reported %.1f, buttons %.1f, above %.2f, below %.2f, pixel %.2fpt)",
            when, row, bar, reported, area[3], above, below, pixel]);
}

// Checks that setting the height fails, the failure text is expected, and the title bar stays unchanged.
static void expectRejected(NSWindow *window, double height, const char *expected, NSString *what) {
    double before = window.frame.size.height - window.contentLayoutRect.size.height;
    char *failure = NULL;
    bool set = windowSetTitlebarHeight(window, height, &failure);
    double after = window.frame.size.height - window.contentLayoutRect.size.height;
    check(!set && failure && strcmp(failure, expected) == 0 && after == before,
        [NSString stringWithFormat:@"%@ is rejected with \"%s\" and keeps the %.1fpt title bar (got %s, \"%s\", %.1fpt)",
            what, expected, before, set ? "set" : "rejected", failure ? failure : "no message", after]);
    free(failure);
}

static bool setHeight(NSWindow *window, double height) {
    char *failure = NULL;
    bool set = windowSetTitlebarHeight(window, height, &failure);
    if (!set) fprintf(stderr, "windowSetTitlebarHeight(%.1f): %s\n", height, failure);
    free(failure);
    return set;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = hostLikeWindow();
    [window orderBack:nil];

    // The first row (--chrome-row of app.css) for frame font scales 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, and the
    // values between them. The last two values check that the title bar becomes lower again when the scale decreases.
    const double rows[] = {40, 45, 54, 63, 72, 90, 108, 54, 40};
    for (size_t i = 0; i < sizeof rows / sizeof rows[0]; i++) {
        double row = rows[i];
        check(setHeight(window, row), [NSString stringWithFormat:@"the title bar takes the requested %.1fpt", row]);
        expectCentred(window, row, @"after the height is set");

        // When the title changes, AppKit lays out the buttons again. The buttons belong to AppKit, so the position
        // stays the same.
        window.title = [NSString stringWithFormat:@"renamed %zu", i];
        [window layoutIfNeeded];
        expectCentred(window, row, @"after a title change");

        NSSize size = i % 2 ? NSMakeSize(600, 400) : NSMakeSize(720, 480);
        [window setContentSize:size];
        [window layoutIfNeeded];
        expectCentred(window, row, @"after a resize");

        check(setHeight(window, row), @"setting the same height again succeeds");
        expectCentred(window, row, @"after the same height is set again");
    }
    check(window.toolbar == nil, @"the window needs no toolbar for its title bar height");

    // AppKit uses a height of 0 or less to mean that there is no custom height, and it does not lay out again with
    // that value.
    expectRejected(window, 0, "title bar height must be a positive finite number", @"a zero height");
    expectRejected(window, -1, "title bar height must be a positive finite number", @"a negative height");
    expectRejected(window, NAN, "title bar height must be a positive finite number", @"a NaN height");
    expectRejected(window, INFINITY, "title bar height must be a positive finite number", @"an infinite height");

    NSWindow *plain = [[[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [plain setReleasedWhenClosed:NO];
    // 0 is the height of a window without a title bar (full screen), so a window that cannot have a title bar reports
    // a negative value.
    check(windowTitlebarHeight(plain) < 0, @"a window without standard buttons reports that it cannot have a title bar");
    expectRejected(plain, 40, "the window has no standard buttons or content view for a title bar",
        @"a title bar height for a window without standard buttons");

    [window close];
    [plain close];
    return failures ? 1 : 0;
}}
