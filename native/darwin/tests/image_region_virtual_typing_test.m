// Checks typing into an image region of the virtual key window (docs/spec/exposure.md#virtual-key-window): the test process is
// never active, so its window takes keys as the virtual key window and the input method does not answer them. A key whose
// text the caller stated types that text, a key without it types what the keyboard layout of the input source makes of it,
// with the dead key state of the layout, and a key of an input method is refused with the source named. The input source of
// the system is not changed: the region reads its source through copyVirtualInputSource, which the test replaces.
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "event_ring.h"
#import "image_region.h"
#import "input_inject.h"
#import "input_virtual.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures;
static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

static NSMutableArray<NSDictionary *> *transactions;
static void regionEvent(void *context, const char *json) {
    (void)context;
    id parsed = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:NULL];
    if ([parsed isKindOfClass:NSDictionary.class] && [parsed[@"type"] isEqual:@"input"]) [transactions addObject:parsed];
}

// The text that the region inserted and the reasons of its errors since the last call.
static NSString *inserted(void) {
    NSMutableString *text = [NSMutableString string];
    for (NSDictionary *transaction in transactions) {
        for (NSDictionary *action in transaction[@"actions"]) {
            if ([action[@"type"] isEqual:@"insert"]) [text appendString:action[@"text"]];
        }
    }
    return text;
}
static NSString *errors(void) {
    NSMutableArray *reasons = [NSMutableArray array];
    for (NSDictionary *transaction in transactions) {
        for (id error in transaction[@"errors"]) [reasons addObject:[error isKindOfClass:NSDictionary.class] ? error[@"reason"] ?: error : error];
    }
    return [reasons componentsJoinedByString:@"; "];
}

static TISInputSourceRef chosenSource;
static TISInputSourceRef copyChosenSource(id self, SEL _cmd) {
    (void)self;
    (void)_cmd;
    return chosenSource ? (TISInputSourceRef)CFRetain(chosenSource) : NULL;
}
// Makes the input source with identifier the source of the region, or reports that the system has none with it.
static BOOL choose(NSString *identifier) {
    if (chosenSource) CFRelease(chosenSource);
    chosenSource = NULL;
    NSArray *sources = (NSArray *)TISCreateInputSourceList((CFDictionaryRef)@{(id)kTISPropertyInputSourceID: identifier}, true);
    if (sources.count > 0) chosenSource = (TISInputSourceRef)CFRetain((TISInputSourceRef)sources[0]);
    [sources release];
    check(chosenSource != NULL, [NSString stringWithFormat:@"the system has the input source %@", identifier]);
    return chosenSource != NULL;
}

static void type(NSWindow *window, const char *key, const char *text) {
    [transactions removeAllObjects];
    BOOL down = sp_input_key(window, key, text, 0, true) == SP_INPUT_DELIVERED;
    BOOL up = sp_input_key(window, key, text, 0, false) == SP_INPUT_DELIVERED;
    check(down && up, [NSString stringWithFormat:@"the key %s is delivered", key]);
    // A key takes its turn of the event queue of the application.
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:0.2];
    while (until.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    transactions = [NSMutableArray array];
    // The correlation identifiers of the inputs are <boot>.<n>; the host gives the boot identifier of its run.
    check(sp_event_set_boot("test-native"), @"the boot identifier of the run is accepted");
    Method method = class_getInstanceMethod(NSClassFromString(@"SPImageRegion"), @selector(copyVirtualInputSource));
    check(method != NULL, @"the region reads its input source through copyVirtualInputSource");
    if (!method) return 1;
    method_setImplementation(method, (IMP)copyChosenSource);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    void *composition = sp_window_set_main_webview(window, main);
    void *surface = sp_surface_create(composition);
    webviewSetFrame(surface, 0, 0, 400, 300);
    webviewSetSurfaceHidden(surface, false);
    void *region = sp_region_create(surface, "view", regionEvent, NULL);
    sp_region_place(region, 0, 0, 0, 0, true);
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    sp_region_focus(region);
    check(window.firstResponder == (NSResponder *)region, @"the region holds the keyboard of the window");

    // The first key makes the window the virtual key window; a key with a stated text types that text whatever the source is.
    if (choose(@"com.apple.inputmethod.Korean.2SetKorean")) {
        type(window, "e", "é");
        check(sp_input_virtual_is(window), @"the window of the key is the virtual key window");
        check([inserted() isEqual:@"é"] && errors().length == 0,
            [NSString stringWithFormat:@"a stated text types that text under an input method (inserted \"%@\", errors \"%@\")",
                inserted(), errors()]);

        // A key without a stated text under an input method is refused with the source named, and types nothing.
        type(window, "g", NULL);
        check(inserted().length == 0 && [errors() containsString:@"com.apple.inputmethod.Korean.2SetKorean"]
                && [errors() containsString:@"not a keyboard layout"],
            [NSString stringWithFormat:@"a key of an input method is refused with its source (inserted \"%@\", errors \"%@\")",
                inserted(), errors()]);
    }

    // A key without a stated text types what the keyboard layout makes of it.
    sp_region_close(region);
    region = sp_region_create(surface, "view", regionEvent, NULL);
    sp_region_place(region, 0, 0, 0, 0, true);
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    sp_region_focus(region);
    if (choose(@"com.apple.keylayout.ABC")) {
        type(window, "q", NULL);
        check([inserted() isEqual:@"q"] && errors().length == 0,
            [NSString stringWithFormat:@"a key of a keyboard layout types its character (inserted \"%@\", errors \"%@\")",
                inserted(), errors()]);
    }

    // A dead key of the layout types nothing, and the key after it types the composed character.
    if (choose(@"com.apple.keylayout.USInternational-PC")) {
        type(window, "'", NULL);
        check(inserted().length == 0 && errors().length == 0,
            [NSString stringWithFormat:@"a dead key types nothing (inserted \"%@\", errors \"%@\")", inserted(), errors()]);
        type(window, "e", NULL);
        check([inserted() isEqual:@"é"] && errors().length == 0,
            [NSString stringWithFormat:@"the key after a dead key types the composed character (inserted \"%@\", errors \"%@\")",
                inserted(), errors()]);
    }

    sp_region_close(region);
    [window close];
    [window release];
    return failures == 0 ? 0 : 1;
}}
