// Checks the display frame of an image region (docs/spec/native-surfaces.md#copy-path-frames): a frame request of a region asks for
// the next display frame of its window once, the region reports that frame through its event callback with the refresh rate of the
// screen that shows the window, a second request before that frame asks nothing more, an idle region reports no frame, a hidden region
// of an occluded window reports its frame, because the display link of the screen runs regardless of the occlusion of the window, and a
// closed region reports none. It opens a window behind the other windows, occludes it with a second window behind the other windows, and
// does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import "image_region.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/event_wait.h"
#import "support/surface_view.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The frame events that each region reported, as their JSON text.
static NSMutableArray<NSString *> *frames;

static void regionEvent(void *context, const char *json) {
    (void)context;
    NSString *event = @(json);
    if ([event containsString:@"\"type\":\"frame\""]) [frames addObject:event];
}

// Counts the refreshes of the screen. Each refresh is a source of the main run loop, so a wait over refreshes judges after each one.
@interface SPFrameRefreshes : NSObject
@property(nonatomic) NSUInteger ticks;
- (void)tick:(CADisplayLink *)link;
@end

@implementation SPFrameRefreshes
- (void)tick:(CADisplayLink *)link {
    (void)link;
    self.ticks++;
}
@end

// Runs the run loop over count refreshes of the screen, so a frame that a region would report late has the time to arrive.
static void waitRefreshes(SPFrameRefreshes *refreshes, NSUInteger count, NSString *what) {
    NSUInteger start = refreshes.ticks;
    eventWait(what, ^BOOL { return refreshes.ticks - start >= count; });
}

int main(int argc, char **argv) { @autoreleasepool {
    (void)argc; (void)argv;
    frames = [NSMutableArray array];
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
    [window orderBack:nil];
    eventWait(@"the window is on a screen", ^BOOL { return window.screen != nil; });
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates the surface");
    check(SPPlaceSurfaceView(surface, view), @"the view web view is placed in the surface");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    SPFrameRefreshes *refreshes = [[SPFrameRefreshes new] autorelease];
    CADisplayLink *link = [window.screen displayLinkWithTarget:refreshes selector:@selector(tick:)];
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];

    void *region = sp_region_create(surface, "copy", regionEvent, NULL);
    sp_region_place(region, 10, 20, 120, 80, true);
    waitRefreshes(refreshes, 3, @"three refreshes without a request");
    check(frames.count == 0, [NSString stringWithFormat:@"a region without a frame request reports no frame: %@", frames]);

    sp_region_want_frame(region);
    sp_region_want_frame(region);
    NSString *late = eventWaitUntil(@"the display frame of the request", 5, ^BOOL { return frames.count > 0; },
        ^NSString *{ return [NSString stringWithFormat:@"%lu frames after %lu refreshes", (unsigned long)frames.count, (unsigned long)refreshes.ticks]; });
    check(late == nil, [NSString stringWithFormat:@"a frame request reports a display frame: %@", late]);
    NSString *want = [NSString stringWithFormat:@"{\"type\":\"frame\",\"refreshRate\":%ld}", (long)window.screen.maximumFramesPerSecond];
    check(frames.count == 1 && [frames.firstObject isEqualToString:want],
        [NSString stringWithFormat:@"the request reports the display frame with the refresh rate of the screen: %@, want %@", frames, want]);
    waitRefreshes(refreshes, 3, @"three refreshes after the display frame");
    check(frames.count == 1, [NSString stringWithFormat:@"two requests before the display frame report one frame: %@", frames]);

    sp_region_want_frame(region);
    late = eventWaitUntil(@"the display frame of the next request", 5, ^BOOL { return frames.count > 1; },
        ^NSString *{ return [NSString stringWithFormat:@"%lu frames after %lu refreshes", (unsigned long)frames.count, (unsigned long)refreshes.ticks]; });
    check(late == nil, [NSString stringWithFormat:@"a request after the display frame reports a display frame: %@", late]);
    check(frames.count == 2, [NSString stringWithFormat:@"a request after the display frame reports one more frame: %@", frames]);

    sp_region_place(region, 10, 20, 120, 80, false);
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSInsetRect(window.frame, -20, -20)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    [cover setReleasedWhenClosed:NO];
    cover.opaque = YES;
    cover.backgroundColor = NSColor.blackColor;
    [cover orderWindow:NSWindowAbove relativeTo:window.windowNumber];
    NSString *visible = eventWaitUntil(@"the occlusion of the window", 5,
        ^BOOL { return !(window.occlusionState & NSWindowOcclusionStateVisible); },
        ^NSString *{ return [NSString stringWithFormat:@"occlusion state %lu", (unsigned long)window.occlusionState]; });
    check(visible == nil, [NSString stringWithFormat:@"the second window occludes the window: %@", visible]);
    sp_region_want_frame(region);
    late = eventWaitUntil(@"the display frame of a hidden region of an occluded window", 5, ^BOOL { return frames.count > 2; },
        ^NSString *{ return [NSString stringWithFormat:@"%lu frames after %lu refreshes", (unsigned long)frames.count, (unsigned long)refreshes.ticks]; });
    check(late == nil, [NSString stringWithFormat:@"a hidden region of an occluded window reports a display frame: %@", late]);
    check(frames.count == 3 && [frames.lastObject isEqualToString:want],
        [NSString stringWithFormat:@"the frame of the occluded window carries the refresh rate of the screen: %@, want %@", frames, want]);
    [cover orderOut:nil];
    [cover release];

    sp_region_want_frame(region);
    sp_region_close(region);
    waitRefreshes(refreshes, 3, @"three refreshes after the close");
    check(frames.count == 3, [NSString stringWithFormat:@"a region closed before its display frame reports none: %@", frames]);

    [link invalidate];
    sp_surface_unplace_view(view);
    [view removeFromSuperview];
    sp_surface_close(surface);
    [window orderOut:nil];
    printf("%s\n", failures ? "FAIL: image_region_frame_test" : "PASS: image_region_frame_test");
    return failures ? 1 : 0;
}}
