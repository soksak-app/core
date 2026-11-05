// Checks that a dialog blurs an image region with the native filter and the radius of a document, and that the facts of
// the region report it as a JSON boolean (docs/spec/native-surfaces.md#regions).
#import <Cocoa/Cocoa.h>
#import <CoreImage/CoreImage.h>
#import <WebKit/WebKit.h>
#import "image_region.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/surface_view.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void receive(void *context, const char *event) { (void)context; (void)event; }

/** The value of `blurred` in the facts of region, as JSON parses it. */
static id blurredOf(void *region) {
    const char *json = sp_region_facts(region);
    NSDictionary *facts = json ? [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)]
        options:0 error:nil] : nil;
    free((void *)json);
    return facts[@"blurred"];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[WKWebView alloc] initWithFrame:window.contentView.bounds];
    WKWebView *view = [[WKWebView alloc] initWithFrame:NSZeroRect];
    [window.contentView addSubview:main];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    BOOL placed = surface && SPPlaceSurfaceView(surface, view);
    webviewSetFrame(surface, 0, 0, 100, 100);
    webviewSetSurfaceHidden(surface, false);
    void *region = placed ? sp_region_create(surface, "blur", receive, NULL) : NULL;
    if (!region) { fprintf(stderr, "FAIL: the fixture has no image region\n"); return 1; }
    NSView *regionView = (NSView *)region;

    check(blurredOf(region) == (id)kCFBooleanFalse, @"a region without a filter reports blurred as the JSON boolean false");
    check(regionView.contentFilters.count == 0, @"a new region has no filter");
    sp_region_background(region, true);
    check(blurredOf(region) == (id)kCFBooleanTrue, @"a blurred region reports blurred as the JSON boolean true");
    CIFilter *filter = regionView.contentFilters.firstObject;
    check([filter.name isEqualToString:@"CIGaussianBlur"], @"the filter of the region is the Gaussian blur of a document");
    check(fabs([[filter valueForKey:kCIInputRadiusKey] doubleValue] - 3) < 0.001,
        [NSString stringWithFormat:@"the radius is 3 CSS pixels of the surface: %@", [filter valueForKey:kCIInputRadiusKey]]);
    sp_region_background(region, false);
    check(blurredOf(region) == (id)kCFBooleanFalse, @"a region whose dialog closed reports blurred false");
    check(regionView.contentFilters.count == 0, @"a region whose dialog closed has no filter");

    sp_region_close(region);
    return failures ? 1 : 0;
} }
