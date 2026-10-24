#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "event_ring.h"
#import "image_region.h"
#import "support/records.h"
#import "webview_geometry.h"

@interface SPControlledInputContext : NSTextInputContext
@property(copy) void (^callback)(id<NSTextInputClient> client);
@property NSUInteger handledEvents;
@property NSUInteger discardedMarkedTextCalls;
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
- (void)discardMarkedText {
    self.discardedMarkedTextCalls++;
    [super discardMarkedText];
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
    NSView *view = (NSView *)region;
    id<NSTextInputClient> client = (id<NSTextInputClient>)region;
    check(view.inputContext != nil,
        @"the normal image region uses AppKit's input context before diagnostic injection");
    SPControlledInputContext *context = [[[SPControlledInputContext alloc] initWithClient:client] autorelease];
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

    // Insert followed by unmark in one physical key callback scope emits one committed action.
    [reports removeAllObjects];
    context.callback = ^(id<NSTextInputClient> client) {
        [client setMarkedText:@"nested" selectedRange:NSMakeRange(6, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        [client insertText:@"nested" replacementRange:NSMakeRange(NSNotFound, 0)];
        [client unmarkText];
    };
    [view keyDown:keyEvent(7, @"x", 0)];
    transaction = reports.count == 1 ? reports[0] : nil;
    actions = transaction[@"actions"];
    check(reports.count == 1 && actions.count == 1 && [actions[0][@"text"] isEqual:@"nested"]
        && [transaction[@"preedit"][@"text"] isEqual:@""] && [transaction[@"errors"] isEqual:@[]],
        [NSString stringWithFormat:@"insert and unmark in one key scope commit once (got %@)", reports]);

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

    [reports removeAllObjects];
    context.callback = ^(id<NSTextInputClient> client) {
        [client setMarkedText:@"pending-before-command" selectedRange:NSMakeRange(22, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        [client doCommandBySelector:@selector(deleteBackward:)];
    };
    [view keyDown:keyEvent(7, @"x", 0)];
    transaction = reports.count == 1 ? reports[0] : nil;
    actions = transaction[@"actions"];
    check(actions.count == 2 && [actions[0][@"type"] isEqual:@"insert"]
        && [actions[0][@"text"] isEqual:@"pending-before-command"]
        && [actions[1][@"type"] isEqual:@"command"]
        && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"a command commits pending text before its ordered command action (got %@)", transaction]);

    // A callback outside keyDown is one transaction, and an empty modifier-key scope sends no input event.
    [reports removeAllObjects];
    [(id<NSTextInputClient>)region setMarkedText:@"standalone" selectedRange:NSMakeRange(10, 0)
        replacementRange:NSMakeRange(NSNotFound, 0)];
    check(reports.count == 1 && [reports[0][@"type"] isEqual:@"input"],
        [NSString stringWithFormat:@"a standalone text callback publishes one transaction (got %@)", reports]);
    [reports removeAllObjects];
    [(id<NSTextInputClient>)region setMarkedText:@"source-change" selectedRange:NSMakeRange(13, 0)
        replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    [NSNotificationCenter.defaultCenter postNotificationName:NSTextInputContextKeyboardSelectionDidChangeNotification
        object:context];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"actions"] count] == 1
        && [transaction[@"actions"][0][@"text"] isEqual:@"source-change"]
        && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"a change of input source commits pending text once (got %@)", reports]);
    [reports removeAllObjects];
    context.callback = nil;
    [view keyDown:keyEvent(7, @"x", NSEventModifierFlagCommand)];
    check(reports.count == 0, [NSString stringWithFormat:@"a key scope with no text callback publishes no input (got %@)", reports]);

    // Replay the controlled Korean callbacks against the exported NSView input client.
    sp_region_close(region);
    region = sp_region_create(surface, "hangul-input-transaction", receiveRegionEvent, NULL);
    check(region != NULL, @"the Hangul input region is created through the exported interface");
    view = (NSView *)region;
    client = (id<NSTextInputClient>)region;
    context = [[[SPControlledInputContext alloc] initWithClient:client] autorelease];
    context.sourceIdentifier = @"com.apple.inputmethod.Korean.2SetKorean";
    sp_region_set_input_context(region, context);
    [window makeFirstResponder:view];
    NSMutableString *committedVowels = [NSMutableString string];
    NSTextView *vowelReference = [[[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 120, 30)] autorelease];
    transaction = nil;
    NSArray<NSDictionary *> *key4Records = nil;
    for (NSUInteger key = 1; key <= 4; key++) {
        [vowelReference setMarkedText:@"ㅏ" selectedRange:NSMakeRange(1, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        if (key > 1) {
            [vowelReference insertText:@"ㅏ" replacementRange:NSMakeRange(NSNotFound, 0)];
            [vowelReference setMarkedText:@"ㅏ" selectedRange:NSMakeRange(1, 0)
                replacementRange:NSMakeRange(NSNotFound, 0)];
        }
        context.callback = ^(id<NSTextInputClient> inputClient) {
            [inputClient setMarkedText:@"ㅏ" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
            if (key > 1) {
                [inputClient insertText:@"ㅏ" replacementRange:NSMakeRange(NSNotFound, 0)];
                [inputClient setMarkedText:@"ㅏ" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
            }
        };
        [reports removeAllObjects];
        if (key == 4) key4Records = capturedEvents(^{ [view keyDown:keyEvent(40, @"ㅏ", 0)]; });
        else [view keyDown:keyEvent(40, @"ㅏ", 0)];
        transaction = reports.count == 1 ? reports[0] : nil;
        for (NSDictionary *action in transaction[@"actions"]) {
            if ([action[@"type"] isEqual:@"insert"]) [committedVowels appendString:action[@"text"]];
        }
        NSString *visible = [committedVowels stringByAppendingString:transaction[@"preedit"][@"text"] ?: @""];
        NSString *expected = [@"ㅏ" stringByPaddingToLength:key withString:@"ㅏ" startingAtIndex:0];
        check(reports.count == 1 && [visible isEqual:expected] && [visible isEqual:vowelReference.string],
            [NSString stringWithFormat:@"Korean key %lu commits and retains marked text without loss or duplication (visible %@, AppKit reference %@, transaction %@)",
                (unsigned long)key, visible, vowelReference.string, transaction]);
        if (key == 1) {
            check([client hasMarkedText] && NSEqualRanges([client markedRange], NSMakeRange(0, 1))
                && NSEqualRanges([client selectedRange], NSMakeRange(1, 0)),
                [NSString stringWithFormat:@"the client exposes marked text and local selection (transaction %@)", transaction]);
        }
    }
    check([transaction[@"actions"] count] == 1 && [transaction[@"actions"][0][@"text"] isEqual:@"ㅏ"]
        && [transaction[@"preedit"][@"text"] isEqual:@"ㅏ"]
        && [transaction[@"preedit"][@"markedRange"][@"location"] isEqual:@0]
        && [transaction[@"preedit"][@"selectedRange"][@"location"] isEqual:@1],
        [NSString stringWithFormat:@"the fourth vowel has one committed insert and one local marked vowel (transaction %@)", transaction]);
    BOOL fourthInsertCallback = NO;
    for (NSDictionary *record in key4Records) {
        NSDictionary *fields = record[@"fields"];
        if ([record[@"name"] isEqual:@"native.input.callback"] && [fields[@"call"] isEqual:@"insertText"]
            && [fields[@"text"] isEqual:@"ㅏ"]) fourthInsertCallback = YES;
    }
    check(fourthInsertCallback, [NSString stringWithFormat:@"the fourth input scope records its commit callback (records %@)", key4Records]);

    [reports removeAllObjects];
    NSArray<NSDictionary *> *invalidSelectionRecords = capturedEvents(^{
        [client setMarkedText:@"x" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    });
    transaction = reports.count == 1 ? reports[0] : nil;
    check([client hasMarkedText] && [transaction[@"preedit"][@"text"] isEqual:@"ㅏ"]
        && [transaction[@"errors"] count] == 1 && [transaction[@"actions"] count] == 0,
        [NSString stringWithFormat:@"invalid local selection leaves the marked buffer unchanged (transaction %@, records %@)", transaction, invalidSelectionRecords]);

    [reports removeAllObjects];
    NSArray<NSDictionary *> *invalidReplacementRecords = capturedEvents(^{
        [client insertText:@"invalid" replacementRange:NSMakeRange(0, 2)];
    });
    transaction = reports.count == 1 ? reports[0] : nil;
    check([client hasMarkedText] && [transaction[@"preedit"][@"text"] isEqual:@"ㅏ"]
        && [transaction[@"errors"] count] == 1 && [transaction[@"actions"] count] == 0,
        [NSString stringWithFormat:@"out-of-buffer insert replacement is rejected (transaction %@, records %@)", transaction, invalidReplacementRecords]);

    sp_region_close(region);
    region = sp_region_create(surface, "input-transaction-invalid-mark-replacement", receiveRegionEvent, NULL);
    check(region != NULL, @"the invalid marked-replacement region is created through the exported interface");
    view = (NSView *)region;
    client = (id<NSTextInputClient>)region;
    context = [[[SPControlledInputContext alloc] initWithClient:client] autorelease];
    sp_region_set_input_context(region, context);
    [window makeFirstResponder:view];
    [client setMarkedText:@"abc" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    context.callback = ^(id<NSTextInputClient> inputClient) {
        [inputClient setMarkedText:@"x" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(3, 1)];
        [inputClient insertText:@"later" replacementRange:NSMakeRange(NSNotFound, 0)];
    };
    NSArray<NSDictionary *> *invalidMarkRecords = capturedEvents(^{ [view keyDown:keyEvent(40, @"x", 0)]; });
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"errors"] count] == 1 && [transaction[@"actions"] count] == 0
        && [transaction[@"preedit"][@"text"] isEqual:@"abc"]
        && [transaction[@"preedit"][@"selectedRange"][@"location"] isEqual:@2],
        [NSString stringWithFormat:@"invalid setMarkedText replacement preserves the buffer, selection, and empty action list (transaction %@)", transaction]);
    BOOL rejectedMarkCallback = NO;
    BOOL rejectedLaterInsertCallback = NO;
    for (NSDictionary *record in invalidMarkRecords) {
        NSDictionary *fields = record[@"fields"];
        if (![record[@"name"] isEqual:@"native.input.callback"]) continue;
        BOOL unchanged = [fields[@"before"][@"markedText"] isEqual:fields[@"after"][@"markedText"]]
            && [fields[@"before"][@"marked"] isEqual:fields[@"after"][@"marked"]]
            && [fields[@"before"][@"selected"] isEqual:fields[@"after"][@"selected"]];
        if ([fields[@"call"] isEqual:@"setMarkedText"]
            && [fields[@"dropped"] isEqual:@"unsupported replacement range"] && unchanged) rejectedMarkCallback = YES;
        if ([fields[@"call"] isEqual:@"insertText"] && [fields[@"text"] isEqual:@"later"]
            && [fields[@"dropped"] isEqual:@"input scope already failed"] && unchanged) rejectedLaterInsertCallback = YES;
    }
    check(rejectedMarkCallback && rejectedLaterInsertCallback,
        [NSString stringWithFormat:@"invalid marked replacement and later callback are explicitly rejected without mutation (records %@)", invalidMarkRecords]);

    sp_region_close(region);
    region = sp_region_create(surface, "input-transaction-failure-prefix", receiveRegionEvent, NULL);
    check(region != NULL, @"the callback-failure region is created through the exported interface");
    view = (NSView *)region;
    client = (id<NSTextInputClient>)region;
    context = [[[SPControlledInputContext alloc] initWithClient:client] autorelease];
    context.sourceIdentifier = @"com.apple.inputmethod.Korean.2SetKorean";
    sp_region_set_input_context(region, context);
    [window makeFirstResponder:view];
    [client insertText:@"가" replacementRange:NSMakeRange(NSNotFound, 0)];
    [client insertText:@"나" replacementRange:NSMakeRange(NSNotFound, 0)];
    [client insertText:@"다" replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    context.callback = ^(id<NSTextInputClient> inputClient) {
        [inputClient insertText:@"라" replacementRange:NSMakeRange(NSNotFound, 0)];
        [inputClient insertText:@"invalid" replacementRange:NSMakeRange(0, 1)];
        [inputClient insertText:@"마" replacementRange:NSMakeRange(NSNotFound, 0)];
    };
    NSArray<NSDictionary *> *failedScopeRecords = capturedEvents(^{ [view keyDown:keyEvent(40, @"ㅏ", 0)]; });
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"actions"] count] == 1 && [transaction[@"actions"][0][@"text"] isEqual:@"라"]
        && [transaction[@"preedit"][@"text"] isEqual:@""] && [transaction[@"errors"] count] == 1,
        [NSString stringWithFormat:@"the failed scope keeps its valid ordered action (transaction %@)", transaction]);
    BOOL rejectedLaterCallback = NO;
    for (NSDictionary *record in failedScopeRecords) {
        NSDictionary *fields = record[@"fields"];
        if ([record[@"name"] isEqual:@"native.input.callback"] && [fields[@"call"] isEqual:@"insertText"]
            && [fields[@"text"] isEqual:@"마"] && [fields[@"dropped"] isEqual:@"input scope already failed"]
            && [fields[@"before"][@"markedText"] isEqual:fields[@"after"][@"markedText"]]
            && [fields[@"before"][@"marked"] isEqual:fields[@"after"][@"marked"]]
            && [fields[@"before"][@"selected"] isEqual:fields[@"after"][@"selected"]]) rejectedLaterCallback = YES;
    }
    check(rejectedLaterCallback, [NSString stringWithFormat:@"post-error callback is rejected without buffer mutation (records %@)", failedScopeRecords]);
    context.callback = ^(id<NSTextInputClient> inputClient) { [inputClient insertText:@"바" replacementRange:NSMakeRange(NSNotFound, 0)]; };
    [reports removeAllObjects];
    [view keyDown:keyEvent(40, @"ㅏ", 0)];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"errors"] count] == 0 && [transaction[@"actions"][0][@"text"] isEqual:@"바"],
        [NSString stringWithFormat:@"new key scope accepts text after failure (transaction %@)", transaction]);

    sp_region_close(region);
    region = sp_region_create(surface, "input-transaction-partial-replacement", receiveRegionEvent, NULL);
    check(region != NULL, @"the marked-buffer replacement region is created through the exported interface");
    view = (NSView *)region;
    client = (id<NSTextInputClient>)region;
    context = [[[SPControlledInputContext alloc] initWithClient:client] autorelease];
    context.sourceIdentifier = @"com.apple.inputmethod.Korean.2SetKorean";
    sp_region_set_input_context(region, context);
    [window makeFirstResponder:view];
    [client setMarkedText:@"abc" selectedRange:NSMakeRange(3, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    NSRange actualRange = NSMakeRange(NSNotFound, 0);
    NSAttributedString *substring = [client attributedSubstringForProposedRange:NSMakeRange(1, 1) actualRange:&actualRange];
    NSAttributedString *outside = [client attributedSubstringForProposedRange:NSMakeRange(3, 1) actualRange:NULL];
    check([substring.string isEqual:@"b"] && NSEqualRanges(actualRange, NSMakeRange(1, 1)) && outside == nil,
        [NSString stringWithFormat:@"input query returns exact marked-buffer UTF-16 text (substring %@, range %@, outside %@)", substring, NSStringFromRange(actualRange), outside]);
    [reports removeAllObjects];
    [client setMarkedText:@"x" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(1, 1)];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"preedit"][@"text"] isEqual:@"axc"]
        && [transaction[@"preedit"][@"markedRange"][@"length"] isEqual:@3]
        && [transaction[@"preedit"][@"selectedRange"][@"location"] isEqual:@2],
        [NSString stringWithFormat:@"partial mark replacement keeps both surrounding characters visible (transaction %@)", transaction]);
    [reports removeAllObjects];
    [client insertText:@"y" replacementRange:NSMakeRange(1, 1)];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"actions"][0][@"text"] isEqual:@"ayc"] && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"partial committed replacement sends the resolved buffer once (transaction %@)", transaction]);
    NSTextView *reference = [[[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 120, 30)] autorelease];
    [reference setMarkedText:@"abc" selectedRange:NSMakeRange(1, 1)
        replacementRange:NSMakeRange(NSNotFound, 0)];
    [reference insertText:@"x" replacementRange:NSMakeRange(NSNotFound, 0)];
    NSString *referenceResult = reference.string;
    [reports removeAllObjects];
    [client setMarkedText:@"abc" selectedRange:NSMakeRange(1, 1) replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    [client insertText:@"x" replacementRange:NSMakeRange(NSNotFound, 0)];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"actions"][0][@"text"] isEqual:referenceResult]
        && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"NSNotFound insertion matches the AppKit text-view reference %@ (transaction %@)", referenceResult, transaction]);

    [reports removeAllObjects];
    [client setMarkedText:@"pending" selectedRange:NSMakeRange(7, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    [client unmarkText];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"actions"][0][@"text"] isEqual:@"pending"] && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"unmark accepts pending text once (transaction %@)", transaction]);
    [reports removeAllObjects];
    [client setMarkedText:@"once" selectedRange:NSMakeRange(4, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    [client insertText:@"once" replacementRange:NSMakeRange(NSNotFound, 0)];
    [client unmarkText];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"actions"][0][@"text"] isEqual:@"once"] && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"unmark after insert does not duplicate the commit (transaction %@)", transaction]);
    [reports removeAllObjects];
    [client setMarkedText:@"cancel" selectedRange:NSMakeRange(6, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    [client setMarkedText:@"" selectedRange:NSMakeRange(0, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
    transaction = reports.count == 1 ? reports[0] : nil;
    check([transaction[@"actions"] count] == 0 && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"explicit empty marked text cancels without commit (transaction %@)", transaction]);

    // Closing a region commits its pending marked buffer, detaches its input context, and releases the responder.
    [reports removeAllObjects];
    [client setMarkedText:@"close-pending" selectedRange:NSMakeRange(13, 0)
        replacementRange:NSMakeRange(NSNotFound, 0)];
    [reports removeAllObjects];
    [view retain];
    sp_region_close(region);
    transaction = reports.count == 1 ? reports[0] : nil;
    NSUInteger closeInsertCount = 0;
    BOOL closeInsertTextMatches = NO;
    for (NSDictionary *action in transaction[@"actions"]) {
        if ([action[@"type"] isEqual:@"insert"]) {
            closeInsertCount++;
            closeInsertTextMatches = [action[@"text"] isEqual:@"close-pending"];
        }
    }
    check(closeInsertCount == 1 && closeInsertTextMatches && [transaction[@"preedit"][@"text"] isEqual:@""],
        [NSString stringWithFormat:@"close commits the pending text exactly once (transaction %@)", reports]);
    check(context.discardedMarkedTextCalls == 1 && view.inputContext != context && ![client hasMarkedText]
        && view.superview == nil && window.firstResponder != view,
        [NSString stringWithFormat:@"close discards input-method state and detaches the responder (discard calls %lu)",
            (unsigned long)context.discardedMarkedTextCalls]);
    [view release];

    sp_surface_close(composition);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
