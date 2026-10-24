// The input client owns pending marked text and applies Korean replacement ranges locally. The test verifies resyllabification
// and ordered commit without storing or replacing committed terminal history.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "event_ring.h"
#import "image_region.h"
#import "webview_geometry.h"

static int failures = 0;
static NSMutableArray<NSDictionary *> *events = nil;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void regionEvent(void *context, const char *json) {
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:NULL];
    if (event) [events addObject:event];
}

static NSString *committed(void) {
    NSMutableString *text = [NSMutableString string];
    for (NSDictionary *event in events) {
        if (![event[@"type"] isEqual:@"input"]) continue;
        for (NSDictionary *action in event[@"actions"]) {
            if ([action[@"type"] isEqual:@"insert"]) [text appendString:action[@"text"]];
        }
    }
    return text;
}

static NSArray *errors(void) {
    NSMutableArray *found = [NSMutableArray array];
    for (NSDictionary *event in events) {
        if (![event[@"type"] isEqual:@"input"]) continue;
        for (NSDictionary *error in event[@"errors"]) [found addObject:error[@"reason"]];
    }
    return found;
}

int main(void) { @autoreleasepool {
    check(sp_event_set_boot("native-test"), @"the boot identifier of the run is accepted");
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
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:surface];
    [window orderBack:nil];
    check(sp_surface_create(main) != NULL, @"the main webview creates the composition");
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, 500, 400);

    events = [NSMutableArray array];
    void *region = sp_region_create(surface, "view", regionEvent, NULL);
    sp_region_place(region, 10, 10, 200, 100, true);
    sp_region_focus(region);
    id<NSTextInputClient> client = (id<NSTextInputClient>)region;
    NSRange none = NSMakeRange(NSNotFound, 0);

    // F143 records Korean resyllabification as replacement of the immediately preceding syllable. Under the dedicated
    // client, AppKit ranges are relative to pending input, so the same revision replaces the local marked character.
    [client setMarkedText:@"한" selectedRange:NSMakeRange(1, 0) replacementRange:none];
    [client setMarkedText:@"하나" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(0, 1)];
    check([client hasMarkedText] && NSEqualRanges([client markedRange], NSMakeRange(0, 2))
        && [client selectedRange].location == 2 && [events.lastObject[@"preedit"][@"text"] isEqual:@"하나"],
        [NSString stringWithFormat:@"Korean resyllabification replaces the local marked syllable (range %@, selection %@, events %@)",
            NSStringFromRange([client markedRange]), NSStringFromRange([client selectedRange]), events]);
    [client insertText:@"하나" replacementRange:NSMakeRange(0, 2)];
    check(errors().count == 0 && [committed() isEqual:@"하나"],
        [NSString stringWithFormat:@"the resolved Korean syllables commit once in order (got %@, errors %@)", committed(), errors()]);

    sp_region_close(region);
    events = [NSMutableArray array];
    region = sp_region_create(surface, "view-append-revision", regionEvent, NULL);
    sp_region_place(region, 10, 10, 200, 100, true);
    sp_region_focus(region);
    client = (id<NSTextInputClient>)region;
    [client setMarkedText:@"한" selectedRange:NSMakeRange(1, 0) replacementRange:none];
    [client setMarkedText:@"하" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(0, 1)];
    [client setMarkedText:@"나" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(1, 0)];
    check(errors().count == 0 && [client hasMarkedText]
        && [client attributedSubstringForProposedRange:NSMakeRange(0, 2) actualRange:NULL].string.length == 2,
        [NSString stringWithFormat:@"a local append after resyllabification preserves the pending syllables (range %@, errors %@)",
            NSStringFromRange([client markedRange]), errors()]);
    [client insertText:@"하나" replacementRange:NSMakeRange(0, 2)];
    check(errors().count == 0 && [committed() isEqual:@"하나"],
        [NSString stringWithFormat:@"replacement then append commits the syllables once (got %@, errors %@)", committed(), errors()]);

    sp_region_close(region);
    events = [NSMutableArray array];
    region = sp_region_create(surface, "view-marked-revision", regionEvent, NULL);
    sp_region_place(region, 10, 10, 200, 100, true);
    sp_region_focus(region);
    client = (id<NSTextInputClient>)region;
    [client setMarkedText:@"가나다" selectedRange:NSMakeRange(3, 0) replacementRange:none];
    [client setMarkedText:@"라" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(1, 1)];
    NSAttributedString *pending = [client attributedSubstringForProposedRange:NSMakeRange(0, 3) actualRange:NULL];
    check([pending.string isEqual:@"가라다"] && [client selectedRange].location == 2,
        [NSString stringWithFormat:@"a partial marked replacement preserves pending text on both sides (pending %@, selection %@)",
            pending.string, NSStringFromRange([client selectedRange])]);
    [client insertText:@"가라다" replacementRange:NSMakeRange(0, 3)];
    check(errors().count == 0 && [committed() isEqual:@"가라다"],
        [NSString stringWithFormat:@"the complete revised Hangul buffer commits exactly once (got %@, errors %@)", committed(), errors()]);

    sp_region_close(region);
    return failures == 0 ? 0 : 1;
} }
