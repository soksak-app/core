#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "event_ring.h"
#import "image_region.h"
#import "support/records.h"
#import "webview_geometry.h"

@interface SPControlledInputContext : NSTextInputContext
@property(copy) void (^callback)(id<NSTextInputClient> client);
@property NSUInteger handledEvents;
@property(copy) NSString *sourceIdentifier;
@end

@implementation SPControlledInputContext
- (BOOL)handleEvent:(NSEvent *)event {
    self.handledEvents++;
    if (self.callback) self.callback(self.client);
    return YES;
}
- (NSString *)selectedKeyboardInputSource {
    return self.sourceIdentifier ?: @"com.apple.keylayout.ABC";
}
- (void)dealloc {
    [_callback release];
    [_sourceIdentifier release];
    [super dealloc];
}
@end

static int failures;
static NSMutableArray<NSDictionary *> *reports;
static NSInteger testWindowNumber;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void receiveRegionEvent(void *context, const char *json) {
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    id value = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:NULL];
    if ([value isKindOfClass:NSDictionary.class]) [reports addObject:value];
}

static NSEvent *keyEvent(NSUInteger keyCode, NSString *characters, NSEventModifierFlags modifiers) {
    return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:modifiers timestamp:0
        windowNumber:(NSInteger)testWindowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO
        keyCode:(unsigned short)keyCode];
}

int main(void) { @autoreleasepool {
    const int8_t policy[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(policy), @"the test stores native input records");
    check(sp_event_set_boot("native-input-transaction-test"), @"the test assigns input correlation identifiers");
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 240, 160)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    testWindowNumber = window.windowNumber;
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:window.contentView.bounds] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:surface];
    void *composition = sp_surface_create(main);
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, 240, 160);
    void *region = sp_region_create(surface, "input-transaction", receiveRegionEvent, NULL);
    check(composition != NULL && region != NULL, @"the exported image region is created");

    reports = [NSMutableArray array];
    NSTextView *view = (NSTextView *)region;
    check(view.inputContext != nil,
        @"the normal image region uses AppKit's input context before diagnostic injection");
    SPControlledInputContext *context = [[[SPControlledInputContext alloc] initWithClient:view] autorelease];
    sp_region_set_input_context(region, context);
    [window makeFirstResponder:view];

    // The controlled context simulates the synchronous callback sequence of one physical input while the
    // application remains inactive: it replaces a marked value, then supplies the final marked state.
    [(id<NSTextInputClient>)region setMarkedText:@"prior" selectedRange:NSMakeRange(5, 0)
        replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    context.callback = ^(id<NSTextInputClient> client) {
        [client insertText:@"committed" replacementRange:NSMakeRange(NSNotFound, 0)];
        [client setMarkedText:@"next" selectedRange:NSMakeRange(4, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
    };
    [view keyDown:keyEvent(7, @"x", 0)];
    check(context.handledEvents == 1, [NSString stringWithFormat:@"the controlled context receives one key event (got %lu)", (unsigned long)context.handledEvents]);

    NSDictionary *transaction = reports.count == 1 ? reports[0] : nil;
    NSArray *actions = transaction[@"actions"];
    check(reports.count == 1 && [transaction[@"type"] isEqual:@"input"],
        [NSString stringWithFormat:@"one physical key publishes one input transaction (got %@)", reports]);
    check(actions.count == 1 && [actions[0][@"type"] isEqual:@"insert"]
        && [actions[0][@"text"] isEqual:@"committed"],
        [NSString stringWithFormat:@"the transaction retains the committed insert (got %@)", transaction]);
    check([transaction[@"preedit"][ @"text"] isEqual:@"next"]
        && [transaction[@"preedit"][ @"markedRange"][ @"length"] isEqual:@4],
        [NSString stringWithFormat:@"the transaction carries only the final marked snapshot (got %@)", transaction]);
    check([transaction[@"errors"] isEqualToArray:@[]],
        @"a valid input transaction has no callback errors");

    // An ordered command callback remains adjacent to its preceding committed insert in the same physical input.
    [reports removeAllObjects];
    context.callback = ^(id<NSTextInputClient> client) {
        [client insertText:@"backspace-input" replacementRange:NSMakeRange(NSNotFound, 0)];
        [client doCommandBySelector:@selector(deleteBackward:)];
    };
    [view keyDown:keyEvent(7, @"x", 0)];
    transaction = reports.count == 1 ? reports[0] : nil;
    actions = transaction[@"actions"];
    check(reports.count == 1 && actions.count == 2
        && [actions[0][@"type"] isEqual:@"insert"]
        && [actions[0][@"text"] isEqual:@"backspace-input"]
        && [actions[1][@"type"] isEqual:@"command"]
        && [actions[1][@"selector"] isEqual:@"deleteBackward:"],
        [NSString stringWithFormat:@"insert and deleteBackward command remain ordered in one transaction (got %@)", reports]);

    // A callback outside keyDown is one transaction, and an empty modifier-key scope sends no input event.
    [reports removeAllObjects];
    [(id<NSTextInputClient>)region setMarkedText:@"standalone" selectedRange:NSMakeRange(10, 0)
        replacementRange:NSMakeRange(NSNotFound, 0)];
    check(reports.count == 1 && [reports[0][@"type"] isEqual:@"input"],
        [NSString stringWithFormat:@"a standalone text callback publishes one transaction (got %@)", reports]);
    [reports removeAllObjects];
    context.callback = nil;
    [view keyDown:keyEvent(7, @"x", NSEventModifierFlagCommand)];
    check(reports.count == 0, [NSString stringWithFormat:@"a key scope with no text callback publishes no input (got %@)", reports]);

    // The controlled context reproduces four consecutive Korean vowel keys from the native callback trace.
    sp_region_close(region);
    region = sp_region_create(surface, "hangul-input-transaction", receiveRegionEvent, NULL);
    check(region != NULL, @"the Hangul input region is created through the exported interface");
    view = (NSTextView *)region;
    context = [[[SPControlledInputContext alloc] initWithClient:view] autorelease];
    context.sourceIdentifier = @"com.apple.inputmethod.Korean.2SetKorean";
    sp_region_set_input_context(region, context);
    [window makeFirstResponder:view];

    context.callback = ^(id<NSTextInputClient> client) {
        [client setMarkedText:@"ㅏ" selectedRange:NSMakeRange(1, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
    };
    [reports removeAllObjects];
    [view keyDown:keyEvent(40, @"ㅏ", 0)];
    check([view.string isEqual:@"ㅏ"] && reports.count == 1,
        [NSString stringWithFormat:@"the first controlled vowel starts composition (document %@, reports %@)", view.string, reports]);

    context.callback = ^(id<NSTextInputClient> client) {
        [client setMarkedText:@"ㅏ" selectedRange:NSMakeRange(1, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        [client insertText:@"ㅏ" replacementRange:NSMakeRange(NSNotFound, 0)];
        [client setMarkedText:@"ㅏ" selectedRange:NSMakeRange(1, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
    };
    for (NSUInteger key = 2; key <= 3; key++) {
        [reports removeAllObjects];
        [view keyDown:keyEvent(40, @"ㅏ", 0)];
        NSString *expected = [@"ㅏ" stringByPaddingToLength:key withString:@"ㅏ" startingAtIndex:0];
        check([view.string isEqual:expected],
            [NSString stringWithFormat:@"vowel %lu retains the expected input document (got %@)", (unsigned long)key, view.string]);
    }
    NSArray<NSDictionary *> *key4Records = capturedEvents(^{
        [reports removeAllObjects];
        [view keyDown:keyEvent(40, @"ㅏ", 0)];
    });
    transaction = reports.count == 1 ? reports[0] : nil;
    actions = transaction[@"actions"];
    check([view.string isEqual:@"ㅏㅏㅏㅏ"] && reports.count == 1
        && [transaction[@"type"] isEqual:@"input"] && actions.count == 1
        && [actions[0][@"type"] isEqual:@"insert"] && [actions[0][@"text"] isEqual:@"ㅏ"]
        && [transaction[@"preedit"][ @"text"] isEqual:@"ㅏㅏㅏ"]
        && [transaction[@"preedit"][ @"markedRange"][ @"location"] isEqual:@2]
        && [transaction[@"preedit"][ @"markedRange"][ @"length"] isEqual:@1],
        [NSString stringWithFormat:@"the fourth vowel publishes its commit and final three-vowel preedit atomically (got %@)", reports]);
    BOOL committedFirstVowel = NO;
    for (NSDictionary *record in key4Records) {
        NSDictionary *fields = record[@"fields"];
        if ([record[@"name"] isEqual:@"native.input.callback"] && [fields[@"call"] isEqual:@"commitThrough"]
            && [fields[@"committed"] isEqual:@"ㅏ"] && [fields[@"to"] isEqual:@1]) committedFirstVowel = YES;
    }
    check(committedFirstVowel,
        [NSString stringWithFormat:@"the fourth-key fixture commits exactly the first vowel (records %@)", key4Records]);

    // Replacing the first committed vowel fails before mutating the native input document or sending an insert report.
    [reports removeAllObjects];
    NSString *before = [[view.string copy] autorelease];
    NSArray<NSDictionary *> *invalidRecords = capturedEvents(^{
        [(id<NSTextInputClient>)region insertText:@"invalid" replacementRange:NSMakeRange(0, 1)];
    });
    check([view.string isEqual:before],
        [NSString stringWithFormat:@"a rejected committed-range replacement leaves the document unchanged (before %@, after %@)", before, view.string]);
    transaction = reports.count == 1 ? reports[0] : nil;
    check([(NSArray *)transaction[@"errors"] count] == 1 && [(NSArray *)transaction[@"actions"] count] == 0
        && [transaction[@"preedit"][ @"text"] isEqual:@"ㅏㅏㅏ"],
        [NSString stringWithFormat:@"a rejected replacement preserves the last valid preedit without an action (got %@)", reports]);
    BOOL recordedUnchangedRejectedCallback = NO;
    BOOL sentCommittedInsert = NO;
    for (NSDictionary *record in invalidRecords) {
        NSDictionary *fields = record[@"fields"];
        if ([record[@"name"] isEqual:@"native.input.callback"] && [fields[@"call"] isEqual:@"insertText"]
            && [fields[@"text"] isEqual:@"invalid"]
            && [fields[@"before"][@"document"] isEqual:fields[@"after"][@"document"]]
            && [fields[@"before"][@"committed"] isEqual:fields[@"after"][@"committed"]]
            && [fields[@"before"][@"marked"] isEqual:fields[@"after"][@"marked"]]
            && [fields[@"before"][@"selected"] isEqual:fields[@"after"][@"selected"]]) {
            recordedUnchangedRejectedCallback = YES;
        }
        if ([record[@"name"] isEqual:@"native.input.report"]
            && [fields[@"report"] containsString:@"\"type\":\"insert\""]) sentCommittedInsert = YES;
    }
    check(recordedUnchangedRejectedCallback,
        [NSString stringWithFormat:@"the rejected callback remains observable with unchanged state (got %@)", invalidRecords]);
    check(!sentCommittedInsert,
        [NSString stringWithFormat:@"the rejected callback sends no committed insert report (got %@)", invalidRecords]);

    sp_region_close(region);
    sp_surface_close(composition);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
