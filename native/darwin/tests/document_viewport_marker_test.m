#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#import "capture.h"
#import "document_view.h"
#import "private/webkit.h"
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "webview_geometry.h"
#import "window_facts.h"
#include <stdlib.h>

static int failures = 0;
static NSDictionary *latestState;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static BOOL onScreen(NSWindow *window) {
    NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
        (CGWindowID)window.windowNumber) autorelease];
    return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
}

static void changed(void *context, const char *json) {
    (void)context;
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    [latestState release];
    latestState = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
}

static BOOL nextPresentation(WKWebView *view) {
    __block BOOL presented = NO;
    [view _doAfterNextPresentationUpdate:^{ presented = YES; }];
    eventWait(@"the next presentation of the document", ^BOOL { return presented; });
    return presented;
}

// A still capture of the window into path; whether it is written. The captures are evidence of the marker and their pixels are
// not judged.
static BOOL still(NSWindow *window, NSString *path) {
    char *error = NULL;
    BOOL captured = sp_capture_still(window.windowNumber, path.fileSystemRepresentation, &error);
    check(captured && [NSFileManager.defaultManager fileExistsAtPath:path],
        [NSString stringWithFormat:@"the nonactivating window capture is written (%s)", error ?: "no error"]);
    free(error);
    return captured;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];

    uint8_t rgb[3] = {0};
    double borderWidth = 0;
    char *error = NULL;
    BOOL disabledWithoutDocument = sp_document_viewport_marker(NULL, false, rgb, &borderWidth, &error);
    check(disabledWithoutDocument && error == NULL && rgb[0] == 0 && rgb[1] == 255 && rgb[2] == 255 && borderWidth == 2,
        @"disabling without a document succeeds and returns cyan 2-point metadata");
    free(error);
    error = NULL;
    check(!sp_document_viewport_marker(NULL, true, rgb, &borderWidth, &error) && error != NULL,
        @"enabling without a document fails with an allocated error");
    free(error);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 620, 480)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 620, 480)];
    window.contentView = content;
    WKWebView *main = [[WKWebView alloc] initWithFrame:content.bounds];
    [content addSubview:main];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    webviewSetFrame(surface, 0, 0, 620, 480);
    webviewSetSurfaceHidden(surface, false);
    // The window goes behind every window, as an application that is not active shows one (docs/spec/hosts.md#launch-activation),
    // so windows of a person may cover it; it draws its document regions while covered, so the captures of the window hold the
    // document whatever covers it. AppKit keeps the order in the open Core Animation transaction of the thread, which the run loop
    // commits at the end of its pass; the commit sends the order to the window server, which lists the window as on screen once
    // the commit returns, covered or not, so the test commits the transaction itself.
    check(sp_document_draw_covered(window, true), @"the capture window draws its document regions while covered");
    [window orderBack:nil];
    [CATransaction flush];
    check(onScreen(window), @"the window server shows the inactive capture window");

    NSString *temporary = temporaryFolder(@"soksak-document-viewport-marker-");
    const char *runFolderText = getenv("SOKSAK_NATIVE_TEST_RUN_FOLDER");
    NSString *captureFolder = runFolderText ? [NSString stringWithUTF8String:runFolderText] : nil;
    if (!captureFolder.length) captureFolder = temporary;
    [[NSFileManager defaultManager] createDirectoryAtPath:captureFolder withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];
    void *document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, NULL, changed, NULL);
    check(document != NULL, @"the test creates an attached document region");
    if (!document) return 1;
    sp_document_place(document, 60, 60, 360, 270, true);
    NSString *pagePath = [temporary stringByAppendingPathComponent:@"page.html"];
    [@"<!doctype html><meta charset=utf-8><style>html,body{margin:0;width:100%;height:100%;background:rgb(30,180,70)}</style>"
        writeToFile:pagePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSURL *pageURL = [NSURL fileURLWithPath:pagePath];
    check(sp_document_load(document, pageURL.absoluteString.UTF8String), @"the document region loads a local color fixture");
    eventWait(@"the document region finishes loading the local fixture", ^BOOL {
        return [[latestState objectForKey:@"url"] isEqual:pageURL.absoluteString] && ![latestState[@"loading"] boolValue];
    });
    check([[latestState objectForKey:@"url"] isEqual:pageURL.absoluteString] && ![latestState[@"loading"] boolValue],
        @"the document region finishes loading the local fixture");
    check(nextPresentation((WKWebView *)document), @"the loaded document page presents before the baseline capture");
    NSString *baselinePath = [captureFolder stringByAppendingPathComponent:@"baseline.png"];
    still(window, baselinePath);
    NSResponder *responder = window.firstResponder;
    NSView *view = (NSView *)document;
    BOOL originalWantsLayer = view.wantsLayer;
    CALayer *originalLayer = view.layer;
    CGFloat originalBorderWidth = originalLayer ? originalLayer.borderWidth : 0;
    CGColorRef requestedOriginalColor = originalLayer && originalLayer.borderColor
        ? CGColorRetain(originalLayer.borderColor) : NULL;
    if (originalLayer) {
        // Give restoration a non-default style that a repeated enable must not replace.
        originalLayer.borderColor = NSColor.orangeColor.CGColor;
        originalLayer.borderWidth = 1;
        originalBorderWidth = 1;
        if (requestedOriginalColor) CGColorRelease(requestedOriginalColor);
        requestedOriginalColor = CGColorRetain(originalLayer.borderColor);
    }

    error = NULL;
    BOOL rejectedMissingMetadata = sp_document_viewport_marker(document, true, NULL, &borderWidth, &error);
    check(!rejectedMissingMetadata && error != NULL, @"enabling without required metadata outputs fails explicitly");
    free(error);
    error = NULL;
    check(view.wantsLayer == originalWantsLayer && view.layer.borderWidth == originalBorderWidth
        && ((view.layer.borderColor == NULL && requestedOriginalColor == NULL)
            || (view.layer.borderColor && requestedOriginalColor
                && CGColorEqualToColor(view.layer.borderColor, requestedOriginalColor))),
        @"a rejected enable leaves the prior layer backing and border style unchanged");

    BOOL started = sp_document_viewport_marker(document, true, rgb, &borderWidth, &error);
    check(started && error == NULL, [NSString stringWithFormat:@"enabling the viewport marker succeeds (%s)", error ?: "no error"]);
    check(rgb[0] == 0 && rgb[1] == 255 && rgb[2] == 255 && borderWidth == 2,
        @"the enabled marker reports cyan RGB and a 2-point border");
    free(error);
    error = NULL;
    BOOL repeated = sp_document_viewport_marker(document, true, rgb, &borderWidth, &error);
    check(repeated && error == NULL, @"repeated enable is idempotent");
    free(error);
    check(window.firstResponder == responder, @"enabling the marker leaves keyboard focus unchanged");

    NSString *firstPath = [captureFolder stringByAppendingPathComponent:@"first.png"];
    check(nextPresentation((WKWebView *)document), @"the marked document page presents before the fixed-geometry capture");
    if (started) still(window, firstPath);

    sp_document_place(document, 110, 90, 280, 230, true);
    check(window.firstResponder == responder, @"resizing and moving the marker leaves keyboard focus unchanged");
    NSString *resizedPath = [captureFolder stringByAppendingPathComponent:@"resized.png"];
    check(nextPresentation((WKWebView *)document), @"the resized document page presents before the resized-geometry capture");
    still(window, resizedPath);

    BOOL stopped = sp_document_viewport_marker(document, false, rgb, &borderWidth, &error);
    check(stopped && error == NULL, @"disabling the viewport marker succeeds");
    free(error);
    error = NULL;
    BOOL stoppedAgain = sp_document_viewport_marker(document, false, rgb, &borderWidth, &error);
    check(stoppedAgain && error == NULL, @"repeated disable is idempotent");
    free(error);
    check(view.wantsLayer == originalWantsLayer && view.layer.borderWidth == originalBorderWidth
        && ((view.layer.borderColor == NULL && requestedOriginalColor == NULL)
            || (view.layer.borderColor && requestedOriginalColor
                && CGColorEqualToColor(view.layer.borderColor, requestedOriginalColor))),
        @"disabling restores the previous layer backing and border style");
    check(window.firstResponder == responder, @"disabling the marker leaves keyboard focus unchanged");
    NSString *stoppedPath = [captureFolder stringByAppendingPathComponent:@"stopped.png"];
    check(nextPresentation((WKWebView *)document), @"the restored document page presents before the stopped-marker capture");
    still(window, stoppedPath);

    BOOL beforeBackgroundWantsLayer = view.wantsLayer;
    BOOL beforeBackgroundUsesCoreImageFilters = view.layerUsesCoreImageFilters;
    NSArray *beforeBackgroundFilters = [view.contentFilters copy];
    CGFloat beforeBackgroundBorderWidth = view.layer ? view.layer.borderWidth : 0;
    CGColorRef beforeBackgroundBorderColor = view.layer && view.layer.borderColor
        ? CGColorRetain(view.layer.borderColor) : NULL;
    view.wantsLayer = NO;
    check(!view.wantsLayer, @"the background interaction starts without layer backing");
    BOOL backgroundMarkerStarted = sp_document_viewport_marker(document, true, rgb, &borderWidth, &error);
    check(backgroundMarkerStarted && error == NULL, @"the marker starts before background configuration");
    free(error);
    error = NULL;
    sp_document_background(document, true);
    sp_document_background(document, false);
    check(view.wantsLayer && view.contentFilters.count == 0,
        @"background disable keeps its layer backing and clears its filters");
    BOOL backgroundMarkerStopped = sp_document_viewport_marker(document, false, rgb, &borderWidth, &error);
    check(backgroundMarkerStopped && error == NULL, @"the marker stops after background configuration");
    free(error);
    error = NULL;
    check(view.wantsLayer, @"stopping the marker preserves background-owned layer backing");
    view.wantsLayer = YES;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    view.layer.borderColor = beforeBackgroundBorderColor;
    view.layer.borderWidth = beforeBackgroundBorderWidth;
    [CATransaction commit];
    view.layerUsesCoreImageFilters = beforeBackgroundUsesCoreImageFilters;
    view.contentFilters = beforeBackgroundFilters;
    view.wantsLayer = beforeBackgroundWantsLayer;
    if (beforeBackgroundBorderColor) CGColorRelease(beforeBackgroundBorderColor);
    [beforeBackgroundFilters release];

    BOOL activeBeforeClose = sp_document_viewport_marker(document, true, rgb, &borderWidth, &error);
    check(activeBeforeClose && error == NULL, @"the marker can be enabled before document disposal");
    free(error);
    error = NULL;
    [view retain];
    sp_document_close(document);
    check(view.wantsLayer == originalWantsLayer && view.layer.borderWidth == originalBorderWidth
        && ((view.layer.borderColor == NULL && requestedOriginalColor == NULL)
            || (view.layer.borderColor && requestedOriginalColor
                && CGColorEqualToColor(view.layer.borderColor, requestedOriginalColor))),
        @"disposing the document restores the prior marker state");
    [view release];
    if (requestedOriginalColor) CGColorRelease(requestedOriginalColor);
    sp_surface_close(surface);
    [window close];
    [main release];
    [content release];
    [window release];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
