// The Korean input method revises the syllable before its newest insert: a final consonant that a vowel follows moves to the
// next syllable, and the input method can append the new syllable before it replaces the previous one. The image region must
// keep that syllable revisable, so every committed syllable reaches the page once and in order (docs/spec/terminal-runtime.md).
// The selected input source is the machine's, so the check answers the two questions of the region about it (whether the
// source composes and whether it composes only Hangul) through the runtime, without changing the input source of the person.
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
    for (NSDictionary *event in events) if ([event[@"type"] isEqual:@"insert"]) [text appendString:event[@"text"]];
    return text;
}

static NSArray *errors(void) {
    NSMutableArray *found = [NSMutableArray array];
    for (NSDictionary *event in events) if ([event[@"type"] isEqual:@"error"]) [found addObject:event[@"reason"]];
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
    NSTextView *view = (NSTextView *)region;
    // The selected source is the Korean input method, which composes only Hangul.
    BOOL (^yes)(id) = ^BOOL(id self) { return YES; };
    for (NSString *name in @[@"selectedSourceComposes", @"selectedSourceComposesOnlyHangul"]) {
        Method method = class_getInstanceMethod(view.class, NSSelectorFromString(name));
        check(method != NULL, [NSString stringWithFormat:@"the region asks %@", name]);
        method_setImplementation(method, imp_implementationWithBlock(yes));
    }
    id<NSTextInputClient> client = (id<NSTextInputClient>)view;
    NSRange none = NSMakeRange(NSNotFound, 0);

    // 한 and then ㅏ: the input method appends 나 and then replaces 한 by 하, as the logged replacement at the committed length
    // less one shows; then Space ends the composition.
    [client insertText:@"한" replacementRange:none];
    [client insertText:@"나" replacementRange:none];
    [client insertText:@"하" replacementRange:NSMakeRange(0, 1)];
    [client insertText:@" " replacementRange:none];
    check(errors().count == 0, [NSString stringWithFormat:@"the revision of the syllable before the newest insert is not a replacement of committed text (got %@)", errors()]);
    check([committed() isEqual:@"하나 "], [NSString stringWithFormat:@"the committed text is 하나 and the space, each once and in order (got %@)", committed()]);

    // The same syllables when the input method replaces first and appends after: the result is the same.
    [events removeAllObjects];
    [client insertText:@"한" replacementRange:none];
    [client insertText:@"하" replacementRange:NSMakeRange(view.textStorage.length - 1, 1)];
    [client insertText:@"나" replacementRange:none];
    [client insertText:@" " replacementRange:none];
    check(errors().count == 0 && [committed() isEqual:@"하나 "],
        [NSString stringWithFormat:@"the replacement before the append commits the same text (got %@, errors %@)", committed(), errors()]);

    // A syllable two before the newest insert is no longer revised, so it is committed while the next syllables compose.
    [events removeAllObjects];
    [client insertText:@"가" replacementRange:none];
    [client insertText:@"나" replacementRange:none];
    [client insertText:@"다" replacementRange:none];
    check([committed() isEqual:@"가"], [NSString stringWithFormat:@"the syllable two before the newest insert is committed (got %@)", committed()]);
    [client insertText:@" " replacementRange:none];
    check([committed() isEqual:@"가나다 "], [NSString stringWithFormat:@"the end of the composition commits the rest in order (got %@)", committed()]);

    sp_region_close(region);
    return failures == 0 ? 0 : 1;
} }
