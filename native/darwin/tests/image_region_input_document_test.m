// A region whose input document keeps document access loses the first syllable of Korean text, so a failed removal reaches the
// host as an input error. Only the operating system can fail the removal, so this test replaces its two calls at link time: the
// definitions below take the place of the system functions for the region, and each forwards to the system function unless a
// case asks it to fail.
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <string.h>
#import "event_ring.h"
#import "image_region.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/surface_view.h"

static int failures = 0;
static NSMutableArray<NSDictionary *> *events = nil;
static OSStatus removalFailure = noErr;
static BOOL documentVariableMissing = NO;
static int removals = 0;
static TSMDocumentID removedDocument = NULL;

static OSStatus systemRemoval(TSMDocumentID document, OSType tag) {
    OSStatus (*system)(TSMDocumentID, OSType) = dlsym(RTLD_NEXT, "TSMRemoveDocumentProperty");
    return system(document, tag);
}

OSStatus TSMRemoveDocumentProperty(TSMDocumentID document, OSType tag) {
    if (tag == kTSMDocumentSupportDocumentAccessPropertyTag) removals++;
    removedDocument = document;
    if (removalFailure != noErr) return removalFailure;
    return systemRemoval(document, tag);
}

Ivar class_getInstanceVariable(Class cls, const char *name) {
    if (documentVariableMissing && strcmp(name, "_documentID") == 0) return NULL;
    Ivar (*system)(Class, const char *) = dlsym(RTLD_NEXT, "class_getInstanceVariable");
    return system(cls, name);
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void regionEvent(void *context, const char *json) {
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:NULL];
    if (event) [events addObject:event];
}

// A failure before an input scope arrives as an error report, and a failure inside one as an error of its input transaction.
static NSArray<NSString *> *reportedFailures(void) {
    NSMutableArray<NSString *> *found = [NSMutableArray array];
    for (NSDictionary *event in events) {
        if ([event[@"type"] isEqual:@"error"]) [found addObject:event[@"reason"]];
        if ([event[@"type"] isEqual:@"input"]) {
            for (NSDictionary *error in event[@"errors"]) [found addObject:error[@"reason"]];
        }
    }
    return found;
}

static NSString *failureReason(OSStatus status) {
    return [NSString stringWithFormat:@"the input document keeps document access (status %d)", (int)status];
}

// Creates a region, asks for its input context twice and returns what the region reported. A region makes its context once, so
// the failure is reported once and the region keeps a context.
static NSArray<NSString *> *openRegion(void *surface, const char *name, BOOL focus, NSString *label, void (^whileOpen)(void)) {
    [events removeAllObjects];
    removals = 0;
    removedDocument = NULL;
    void *region = sp_region_create(surface, name, regionEvent, NULL);
    sp_region_place(region, 10, 10, 200, 100, true);
    if (focus) sp_region_focus(region);
    NSTextInputContext *context = ((NSView *)region).inputContext;
    check([NSStringFromClass(context.class) isEqual:@"SPRegionInputContext"], [NSString stringWithFormat:@"%@: the region has its input context", label]);
    check(((NSView *)region).inputContext == context, [NSString stringWithFormat:@"%@: the region makes its input context once", label]);
    // An input transaction leaves the region when its scope closes, so the events are complete here.
    NSArray<NSString *> *reported = reportedFailures();
    if (whileOpen) whileOpen();
    sp_region_close(region);
    return reported;
}

int main(void) { @autoreleasepool {
    check(sp_event_set_boot("test-native"), @"the boot identifier of the run is accepted");
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
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    check(surface != NULL, @"the main webview creates the surface");
    check(SPPlaceSurfaceView(surface, view), @"the view web view is placed in the surface");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    events = [NSMutableArray array];

    NSArray<NSString *> *reported = openRegion(surface, "removed", NO, @"removal", ^{
        UInt32 value = 0;
        UInt32 size = 0;
        check(TSMGetDocumentProperty(removedDocument, kTSMDocumentSupportDocumentAccessPropertyTag, sizeof value, &size, &value) != noErr,
            @"removal: the document states no document access");
        // The status of a property already absent is one that the context takes as a removal.
        OSStatus absent = systemRemoval(removedDocument, kTSMDocumentSupportDocumentAccessPropertyTag);
        printf("MEASURE: the system answers %d for a property already absent\n", (int)absent);
        check(absent == noErr || absent == tsmDocPropertyNotFoundErr,
            [NSString stringWithFormat:@"removal: a property already absent is no failure of the removal (%d)", (int)absent]);
    });
    check(removals == 1, [NSString stringWithFormat:@"removal: the context removes document access once (%d)", removals]);
    check(reported.count == 0, [NSString stringWithFormat:@"removal: a removal that succeeds reports nothing (%@)", reported]);

    // A document that never stated document access is the state the removal asks for.
    removalFailure = tsmDocPropertyNotFoundErr;
    reported = openRegion(surface, "absent", NO, @"absent property", nil);
    check(removals == 1, [NSString stringWithFormat:@"absent property: the context asks once (%d)", removals]);
    check(reported.count == 0, [NSString stringWithFormat:@"absent property: a property already absent reports nothing (%@)", reported]);
    removalFailure = noErr;

    removalFailure = tsmInvalidDocIDErr;
    reported = openRegion(surface, "refused", NO, @"refused removal", nil);
    check(removals == 1, [NSString stringWithFormat:@"refused removal: the context asks once (%d)", removals]);
    check([reported isEqual:@[failureReason(tsmInvalidDocIDErr)]],
        [NSString stringWithFormat:@"refused removal: the status reaches the host once (%@)", reported]);

    reported = openRegion(surface, "refused-focused", YES, @"refused removal in focus", nil);
    check([reported isEqual:@[failureReason(tsmInvalidDocIDErr)]],
        [NSString stringWithFormat:@"refused removal in focus: the status reaches the host once (%@)", reported]);
    removalFailure = noErr;

    documentVariableMissing = YES;
    reported = openRegion(surface, "no-variable", NO, @"missing variable", nil);
    check(removals == 0, [NSString stringWithFormat:@"missing variable: nothing is removed from an unknown document (%d)", removals]);
    check([reported isEqual:@[failureReason(paramErr)]],
        [NSString stringWithFormat:@"missing variable: the failure reaches the host once (%@)", reported]);
    documentVariableMissing = NO;

    [window close];
    [window release];
    return failures ? 1 : 0;
}}
