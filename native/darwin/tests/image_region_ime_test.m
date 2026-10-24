// Sends physical keys to the active key window and checks the composition result of the macOS Korean 2-set input method.
//
// The input method handles only the active input context of the key window, so this check activates the application and takes the focus,
// and during the check switches the input source between English and Korean 2-set. At the end it restores the previous input source and the previous application.
// It is not part of make test and runs only by make test-activation. It fails if the Korean 2-set input source is not enabled.
// Keys are sent through the same -[NSWindow sendEvent:] path as the endpoint injector. The check first confirms that the AppKit text view control produces
// the correct document through this path, records the callbacks of a minimal input client without a document as measured values,
// and then checks that the image region commits exactly the order reported by the user (Hangul after ddd).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "event_ring.h"
#import "image_region.h"
#import "input_inject.h"
#import "input_source.h"
#import "support/ime_reference_state.h"
#import "support/records.h"
#import "webview_geometry.h"

static NSString *const ABC = @"com.apple.keylayout.ABC";
static NSString *const KOREAN_2SET = @"com.apple.inputmethod.Korean.2SetKorean";
static NSDate *traceDeadline = nil;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSMutableArray<NSDictionary *> *events = nil;

static void regionEvent(void *context, const char *json) {
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    NSDictionary *event = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    [events addObject:event ?: @{@"type": @"invalid", @"raw": [NSString stringWithUTF8String:json]}];
}

// Takes and processes application events while waiting. Activation and input method responses arrive as events.
static BOOL pump(BOOL (^done)(void)) {
    NSDate *localDeadline = [NSDate dateWithTimeIntervalSinceNow:10];
    NSDate *deadline = traceDeadline && [traceDeadline compare:localDeadline] == NSOrderedAscending
        ? traceDeadline : localDeadline;
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    return done();
}

static NSString *currentSourceID(void) {
    char *identifier = sp_input_source_current();
    NSString *result = identifier ? [NSString stringWithUTF8String:identifier] : nil;
    free(identifier);
    return result;
}

// The control text view. It records the callbacks and ranges that the input method sent, unchanged.
@interface SPRecordingTextView : NSTextView
@property(retain) NSMutableArray *calls;
- (void)recordCall:(NSString *)call;
@end
@implementation SPRecordingTextView
- (void)recordCall:(NSString *)call {
    [self.calls addObject:[NSString stringWithFormat:@"%@ => document %@ marked %@ selected %@", call, self.string,
        self.hasMarkedText ? NSStringFromRange(self.markedRange) : @"none", NSStringFromRange(self.selectedRange)]];
}
- (void)insertText:(id)string replacementRange:(NSRange)range {
    [super insertText:string replacementRange:range];
    [self recordCall:[NSString stringWithFormat:@"insert(%@, replace %@)",
        [string isKindOfClass:NSAttributedString.class] ? [string string] : string, NSStringFromRange(range)]];
}
- (void)setMarkedText:(id)string selectedRange:(NSRange)selected replacementRange:(NSRange)range {
    [super setMarkedText:string selectedRange:selected replacementRange:range];
    [self recordCall:[NSString stringWithFormat:@"mark(%@, selected %@, replace %@)",
        [string isKindOfClass:NSAttributedString.class] ? [string string] : string,
        NSStringFromRange(selected), NSStringFromRange(range)]];
}
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    NSAttributedString *result = [super attributedSubstringForProposedRange:range actualRange:actual];
    [self recordCall:[NSString stringWithFormat:@"read(%@) -> %@", NSStringFromRange(range), result.string]];
    return result;
}
- (void)unmarkText {
    [super unmarkText];
    [self recordCall:@"unmark"];
}
- (void)doCommandBySelector:(SEL)selector {
    [super doCommandBySelector:selector];
    [self recordCall:NSStringFromSelector(selector)];
}
- (void)keyDown:(NSEvent *)event {
    [super keyDown:event];
    [self recordCall:[NSString stringWithFormat:@"key(%@)", event.charactersIgnoringModifiers]];
}
- (void)dealloc { [_calls release]; [super dealloc]; }
@end

// A minimal input client without a document. It does not keep the committed string and holds only the composition string.
@interface SPMinimalClient : NSView <NSTextInputClient>
@property(retain) NSMutableArray *calls;
@property(copy) NSString *marked;
@property(retain) NSMutableString *committed;
@end
@implementation SPMinimalClient
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event { [self.inputContext handleEvent:event]; }
- (void)insertText:(id)string replacementRange:(NSRange)range {
    NSString *text = [string isKindOfClass:NSAttributedString.class] ? [string string] : string;
    [self.calls addObject:[NSString stringWithFormat:@"insert(%@, replace %@)", text, NSStringFromRange(range)]];
    [self.committed appendString:text];
    self.marked = @"";
}
- (void)setMarkedText:(id)string selectedRange:(NSRange)selected replacementRange:(NSRange)range {
    NSString *text = [string isKindOfClass:NSAttributedString.class] ? [string string] : string;
    [self.calls addObject:[NSString stringWithFormat:@"mark(%@, selected %@, replace %@)", text,
        NSStringFromRange(selected), NSStringFromRange(range)]];
    self.marked = text;
}
- (void)unmarkText { [self.calls addObject:@"unmark"]; [self.committed appendString:self.marked ?: @""]; self.marked = @""; }
- (BOOL)hasMarkedText { return self.marked.length > 0; }
- (NSRange)markedRange { return self.marked.length ? NSMakeRange(0, self.marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return NSMakeRange(NSNotFound, 0); }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    [self.calls addObject:[NSString stringWithFormat:@"read(%@)", NSStringFromRange(range)]];
    return nil;
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    return [self.window convertRectToScreen:[self convertRect:self.bounds toView:nil]];
}
- (void)doCommandBySelector:(SEL)selector { [self.calls addObject:NSStringFromSelector(selector)]; }
- (void)dealloc { [_calls release]; [_marked release]; [_committed release]; [super dealloc]; }
@end

// A plain NSView input client that holds its own document. It applies the replacement range of the input method to the document without NSTextView.
// It is a control that compares, in the same order, whether the NSTextView superclass of the image region is needed (F8-9).
@interface SPDocumentClient : NSView <NSTextInputClient>
@property(retain) NSMutableString *document;
@property NSRange marked;
@property NSRange selected;
@end
@implementation SPDocumentClient
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event { [self.inputContext handleEvent:event]; }
- (NSRange)target:(NSRange)replacement {
    if (replacement.location != NSNotFound) return replacement;
    return self.marked.location != NSNotFound ? self.marked : self.selected;
}
- (void)insertText:(id)string replacementRange:(NSRange)replacement {
    NSString *text = [string isKindOfClass:NSAttributedString.class] ? [string string] : string;
    NSRange range = [self target:replacement];
    [self.document replaceCharactersInRange:range withString:text];
    self.marked = NSMakeRange(NSNotFound, 0);
    self.selected = NSMakeRange(range.location + text.length, 0);
}
- (void)setMarkedText:(id)string selectedRange:(NSRange)selected replacementRange:(NSRange)replacement {
    NSString *text = [string isKindOfClass:NSAttributedString.class] ? [string string] : string;
    NSRange range = [self target:replacement];
    [self.document replaceCharactersInRange:range withString:text];
    self.marked = text.length ? NSMakeRange(range.location, text.length) : NSMakeRange(NSNotFound, 0);
    self.selected = NSMakeRange(range.location + selected.location, selected.length);
}
- (void)unmarkText { self.marked = NSMakeRange(NSNotFound, 0); }
- (BOOL)hasMarkedText { return self.marked.location != NSNotFound; }
- (NSRange)markedRange { return self.marked; }
- (NSRange)selectedRange { return self.selected; }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    NSRange clipped = NSIntersectionRange(range, NSMakeRange(0, self.document.length));
    if (actual) *actual = clipped;
    return [[[NSAttributedString alloc] initWithString:[self.document substringWithRange:clipped]] autorelease];
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    return [self.window convertRectToScreen:[self convertRect:self.bounds toView:nil]];
}
- (void)doCommandBySelector:(SEL)selector {
    if (selector == @selector(insertNewline:)) [self insertText:@"\n" replacementRange:NSMakeRange(NSNotFound, 0)];
}
- (void)dealloc { [_document release]; [super dealloc]; }
@end

static NSArray *valuesOfType(NSString *type, NSUInteger from) {
    NSMutableArray *values = [NSMutableArray array];
    for (NSUInteger i = from; i < events.count; i++) {
        if ([events[i][@"type"] isEqual:type]) [values addObject:events[i][@"text"] ?: NSNull.null];
    }
    return values;
}

// Types the order reported by the user. Types ddd with the English input source, switches to Korean 2-set, and types Hangul (g k s r m f) and
// Space. For each key it waits until answered increases.
static void typeKey(NSWindow *window, NSString *key, NSUInteger (^answered)(void)) {
    NSUInteger before = answered();
    BOOL sent = (sp_input_key(window, key.UTF8String, NULL, 0, true) == SP_INPUT_DELIVERED) && (sp_input_key(window, key.UTF8String, NULL, 0, false) == SP_INPUT_DELIVERED);
    if (!sent) {
        check(NO, [NSString stringWithFormat:@"the injector sends %@", key]);
        return;
    }
    check(pump(^BOOL { return answered() > before; }), [NSString stringWithFormat:@"the client answers %@", key]);
}

static void selectSource(NSString *source, NSTextInputContext *context) {
    check(sp_input_source_select(source.UTF8String), [NSString stringWithFormat:@"%@ is selected", source]);
    pump(^BOOL { return [context.selectedKeyboardInputSource isEqual:source]; });
}

// Types the first syllable (U+D55C) and Space right after the input source switch. The input method composes this syllable with a replacement range.
static void typeSwitchedSyllable(NSWindow *window, NSTextInputContext *context, NSUInteger (^answered)(void)) {
    selectSource(ABC, context);
    selectSource(KOREAN_2SET, context);
    for (NSString *key in @[@"g", @"k", @"s", @"Space"]) typeKey(window, key, answered);
}

static void typeDddHangul(NSWindow *window, NSTextInputContext *context, NSUInteger (^answered)(void)) {
    selectSource(ABC, context);
    for (NSString *key in @[@"d", @"d", @"d"]) typeKey(window, key, answered);
    selectSource(KOREAN_2SET, context);
    for (NSString *key in @[@"g", @"k", @"s", @"r", @"m", @"f", @"Space"]) typeKey(window, key, answered);
}

static BOOL pumpUntil(BOOL (^done)(void), NSDate *deadline) {
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSDate *pollUntil = [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, deadline.timeIntervalSinceNow)];
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:pollUntil
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    return done();
}

static BOOL typeKeyUntil(NSWindow *window, NSString *key, NSUInteger (^answered)(void), NSDate *deadline) {
    if (deadline.timeIntervalSinceNow <= 0) {
        check(NO, [NSString stringWithFormat:@"the bounded trace deadline expired before %@", key]);
        return NO;
    }
    NSUInteger before = answered();
    sp_input_result down = sp_input_key(window, key.UTF8String, NULL, 0, true);
    sp_input_result up = sp_input_key(window, key.UTF8String, NULL, 0, false);
    if (down != SP_INPUT_DELIVERED || up != SP_INPUT_DELIVERED) {
        check(NO, [NSString stringWithFormat:@"the bounded trace sends %@ (down %@, up %@)", key,
            @(down), @(up)]);
        return NO;
    }
    BOOL received = pumpUntil(^BOOL { return answered() > before; }, deadline);
    check(received, [NSString stringWithFormat:@"the bounded trace receives %@ before its shared deadline", key]);
    return received;
}

static void selectSourceUntil(NSString *source, NSTextInputContext *context, NSDate *deadline) {
    check(sp_input_source_select(source.UTF8String), [NSString stringWithFormat:@"%@ is selected for the bounded trace", source]);
    check(pumpUntil(^BOOL { return [context.selectedKeyboardInputSource isEqual:source]; }, deadline),
        [NSString stringWithFormat:@"%@ reaches the current input context before the shared deadline", source]);
}

static NSDictionary *textViewState(SPRecordingTextView *view) {
    NSString *document = [[view.string copy] autorelease];
    return @{@"document": document ?: @"", @"marked": @(view.hasMarkedText),
        @"markedRange": NSStringFromRange(view.markedRange), @"selectedRange": NSStringFromRange(view.selectedRange),
        @"callbacks": [[view.calls copy] autorelease]};
}

static NSDictionary *regionState(NSUInteger from) {
    NSString *committed = [valuesOfType(@"insert", from) componentsJoinedByString:@""];
    NSString *preedit = [valuesOfType(@"compose", from) lastObject] ?: @"";
    NSDictionary *composition = nil;
    for (NSUInteger index = from; index < events.count; index++) {
        if ([events[index][@"type"] isEqual:@"compose"]) composition = events[index];
    }
    NSDictionary *selected = composition[@"selectedRange"];
    NSString *selectedRange = @"{location=not-found, length=0}";
    if ([selected isKindOfClass:NSDictionary.class]) {
        NSRange global = NSMakeRange(committed.length + [selected[@"location"] unsignedIntegerValue],
            [selected[@"length"] unsignedIntegerValue]);
        selectedRange = NSStringFromRange(global);
    }
    return @{@"committed": committed ?: @"", @"preedit": preedit,
        @"document": [NSString stringWithFormat:@"%@%@", committed ?: @"", preedit],
        @"selectedRange": selectedRange,
        @"markedRange": preedit.length ? NSStringFromRange(NSMakeRange(committed.length, preedit.length))
            : @"{location=not-found, length=0}",
        @"reports": [events subarrayWithRange:NSMakeRange(from, events.count - from)]};
}

static void printTrace(NSString *label, NSString *key, NSDictionary *control, NSDictionary *region, NSArray *native) {
    NSDictionary *trace = @{@"case": label, @"key": key, @"control": control, @"region": region, @"native": native};
    NSData *data = [NSJSONSerialization dataWithJSONObject:trace options:NSJSONWritingFragmentsAllowed error:NULL];
    printf("TRACE: %s\n", [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String]);
}

static void checkRegionKeyRecords(NSArray<NSDictionary *> *records, NSString *key) {
    NSMutableArray<NSDictionary *> *keyDown = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *reports = [NSMutableArray array];
    for (NSDictionary *record in records) {
        if ([record[@"name"] isEqual:@"native.input.key_down"]) [keyDown addObject:record];
        if ([record[@"name"] isEqual:@"native.input.report"]) [reports addObject:record];
    }
    check(keyDown.count == 1, [NSString stringWithFormat:@"image region records one native key-down for %@ (got %@)", key, keyDown]);
    check(reports.count > 0, [NSString stringWithFormat:@"image region records its report for %@ (records %@)", key, records]);
    if (keyDown.count != 1) return;
    for (NSDictionary *report in reports) {
        check([report[@"cids"] isEqual:keyDown.firstObject[@"cids"]],
            [NSString stringWithFormat:@"%@ callback report retains the key correlation identifier (key %@, report %@)",
                key, keyDown.firstObject, report]);
    }
}

// The focused activation-tier reproduction. It compares the system input method's full text-view document and selection
// with the image-region's committed and preedit reports after each physical-layout key.
static void backspaceTrace(NSWindow *window, SPRecordingTextView *control, void *region) {
    NSDate *deadline = traceDeadline;
    int8_t levels[] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(levels), @"native input trace records are enabled for the bounded run");
    NSMutableArray<NSDictionary *> *controlStates = [NSMutableArray array];
    NSMutableArray<NSArray<NSDictionary *> *> *controlNative = [NSMutableArray array];
    NSUInteger (^controlAnswered)(void) = ^NSUInteger {
        return [control.calls indexesOfObjectsPassingTest:^BOOL(NSString *call, NSUInteger index, BOOL *stop) {
            return ![call hasPrefix:@"key("];
        }].count;
    };

    [control.inputContext discardMarkedText];
    control.string = @"";
    [control.calls removeAllObjects];
    selectSourceUntil(ABC, control.inputContext, deadline);
    selectSourceUntil(KOREAN_2SET, control.inputContext, deadline);
    if (![control.inputContext.selectedKeyboardInputSource isEqual:KOREAN_2SET]) return;
    for (NSUInteger index = 0; index < 8 && deadline.timeIntervalSinceNow > 0; index++) {
        __block BOOL received = NO;
        NSArray *native = capturedEvents(^{ received = typeKeyUntil(window, @"k", controlAnswered, deadline); });
        NSDictionary *controlStateNow = textViewState(control);
        [controlStates addObject:controlStateNow];
        [controlNative addObject:native];
        printTrace(@"AppKit reference", @"k", controlStateNow, @{}, native);
        if (!received) break;
    }
    __block BOOL backspaceReceived = NO;
    NSArray *controlBackspace = capturedEvents(^{
        backspaceReceived = typeKeyUntil(window, @"Backspace", controlAnswered, deadline);
    });
    NSDictionary *controlAfterBackspace = textViewState(control);
    [controlStates addObject:controlAfterBackspace];
    [controlNative addObject:controlBackspace];
    printTrace(@"AppKit reference", @"Backspace", controlAfterBackspace, @{}, controlBackspace);
    __block BOOL spaceReceived = NO;
    NSArray *controlSpace = capturedEvents(^{ spaceReceived = typeKeyUntil(window, @"Space", controlAnswered, deadline); });
    NSDictionary *controlAfterSpace = textViewState(control);
    [controlStates addObject:controlAfterSpace];
    [controlNative addObject:controlSpace];
    printTrace(@"AppKit reference", @"Space", controlAfterSpace, @{}, controlSpace);

    sp_region_focus(region);
    NSTextInputContext *regionContext = ((NSView *)region).inputContext;
    check(pumpUntil(^BOOL { return NSTextInputContext.currentInputContext == regionContext; }, deadline),
        @"the image region input context becomes current before the trace");
    selectSourceUntil(ABC, regionContext, deadline);
    selectSourceUntil(KOREAN_2SET, regionContext, deadline);
    if (![regionContext.selectedKeyboardInputSource isEqual:KOREAN_2SET]) return;
    [events removeAllObjects];
    NSMutableArray<NSDictionary *> *regionStates = [NSMutableArray array];
    NSMutableArray<NSArray<NSDictionary *> *> *regionNative = [NSMutableArray array];
    NSUInteger regionStart = events.count;
    NSUInteger (^regionAnswered)(void) = ^NSUInteger { return events.count; };
    for (NSUInteger index = 0; index < 8 && deadline.timeIntervalSinceNow > 0; index++) {
        __block BOOL received = NO;
        NSArray *native = capturedEvents(^{ received = typeKeyUntil(window, @"k", regionAnswered, deadline); });
        NSDictionary *state = regionState(regionStart);
        checkRegionKeyRecords(native, @"k");
        [regionStates addObject:state];
        [regionNative addObject:native];
        printTrace(@"image region", @"k", @{}, state, native);
        if (!received) break;
    }
    __block BOOL regionBackspaceReceived = NO;
    NSArray *regionBackspace = capturedEvents(^{
        regionBackspaceReceived = typeKeyUntil(window, @"Backspace", regionAnswered, deadline);
    });
    NSDictionary *regionAfterBackspace = regionState(regionStart);
    checkRegionKeyRecords(regionBackspace, @"Backspace");
    [regionStates addObject:regionAfterBackspace];
    [regionNative addObject:regionBackspace];
    printTrace(@"image region", @"Backspace", @{}, regionAfterBackspace, regionBackspace);
    __block BOOL regionSpaceReceived = NO;
    NSArray *regionSpace = capturedEvents(^{ regionSpaceReceived = typeKeyUntil(window, @"Space", regionAnswered, deadline); });
    NSDictionary *regionAfterSpace = regionState(regionStart);
    checkRegionKeyRecords(regionSpace, @"Space");
    [regionStates addObject:regionAfterSpace];
    [regionNative addObject:regionSpace];
    printTrace(@"image region", @"Space", @{}, regionAfterSpace, regionSpace);

    check(controlStates.count == 10 && regionStates.count == 10,
        [NSString stringWithFormat:@"both inputs complete eight k keys, Backspace, and Space before the shared deadline (reference %@ states, region %@ states)",
            @(controlStates.count), @(regionStates.count)]);
    check(backspaceReceived && spaceReceived && regionBackspaceReceived && regionSpaceReceived,
        @"both controls answer Backspace and Space before the shared deadline");
    NSUInteger count = MIN(controlStates.count, regionStates.count);
    for (NSUInteger index = 0; index < count; index++) {
        NSDictionary *reference = controlStates[index];
        NSDictionary *actual = regionStates[index];
        NSString *expectedDocument = sp_ime_reference_expected_document(index);
        NSString *referenceMismatch = sp_ime_reference_state_mismatch(reference, expectedDocument,
            NSMakeRange(expectedDocument.length, 0), NSMakeRange(expectedDocument.length, 0));
        check(referenceMismatch == nil, [NSString stringWithFormat:@"AppKit reference checkpoint %lu matches its expected document and ranges%@",
            (unsigned long)index + 1, referenceMismatch ? [@": " stringByAppendingString:referenceMismatch] : @""]);
        check([reference[@"document"] isEqual:actual[@"document"]],
            [NSString stringWithFormat:@"input document %lu agrees between AppKit and image region (reference %@; region %@)",
                (unsigned long)index + 1, reference, actual]);
    }
    check(controlStates.count == 10 && regionStates.count == 10,
        [NSString stringWithFormat:@"the trace records a callback and native event batch for every key (reference %@, region %@)",
            @([controlNative count]), @([regionNative count])]);
}

// tests/support/no_activation.m: this check activates the application in make test-activation.
void sp_test_declare_activation(void);

int main(int argc, const char *argv[]) { @autoreleasepool {
    BOOL focusedTrace = argc == 2 && strcmp(argv[1], "--backspace-trace") == 0;
    if (focusedTrace) traceDeadline = [NSDate dateWithTimeIntervalSinceNow:55];
    sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    events = [NSMutableArray new];

    NSString *previousSource = currentSourceID();
    if (!previousSource) {
        fprintf(stderr, "FAIL: the selected input source could not be read\n");
        return 1;
    }
    NSRunningApplication *previousApp = [[NSWorkspace.sharedWorkspace.frontmostApplication retain] autorelease];
    if (focusedTrace) {
        printf("PRECHECK: inputSource=%s frontmostPid=%d frontmostBundle=%s window=single-key-window budgetSeconds=55 cleanupSeconds=5\n",
            previousSource.UTF8String, previousApp.processIdentifier,
            previousApp.bundleIdentifier.UTF8String ?: "unknown");
    }

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:surface];
    check(sp_surface_create(main) != NULL, @"the main webview creates the composition");
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    void *region = sp_region_create(surface, "ime", regionEvent, NULL);
    sp_region_place(region, 10, 10, 10, 10, true);

    if (!sp_input_source_select(KOREAN_2SET.UTF8String)) {
        fprintf(stderr, "FAIL: the %s input source is not enabled\n", KOREAN_2SET.UTF8String);
        if (focusedTrace) {
            sp_region_close(region);
            [window close];
            [window release];
            if (previousApp) [previousApp activateWithOptions:0];
            return 1;
        }
        return 1;
    }
    check(pump(^BOOL { return [currentSourceID() isEqual:KOREAN_2SET]; }),
        [NSString stringWithFormat:@"Korean 2-Set is the current input source (got %@)", currentSourceID()]);
    [NSApp activateIgnoringOtherApps:YES];
    [window makeKeyAndOrderFront:nil];
    check(pump(^BOOL { return NSApp.isActive && window.isKeyWindow; }), @"the test window becomes the key window");
    sp_region_focus(region);
    check(window.firstResponder == (NSResponder *)region, @"the image region is the first responder");
    // Waits until the input context of the region has selected Korean 2-set before sending keys.
    NSTextInputContext *context = ((NSView *)region).inputContext;
    check(pump(^BOOL { return NSTextInputContext.currentInputContext == context
            && [context.selectedKeyboardInputSource isEqual:KOREAN_2SET]; }),
        [NSString stringWithFormat:@"the region's input context is current and selects Korean 2-Set (current %d, selected %@)",
            NSTextInputContext.currentInputContext == context, context.selectedKeyboardInputSource]);
    // Control: confirms that the AppKit default text view composes the keys received through the same path (-[NSWindow sendEvent:], same as the endpoint injector) into
    // the correct document. Right after the switch the input method rewrites the committed character through a replacement range, so
    // the final document is compared, not the marked state.
    SPRecordingTextView *control = [[[SPRecordingTextView alloc] initWithFrame:NSMakeRect(300, 10, 150, 40)] autorelease];
    control.calls = [NSMutableArray array];
    [window.contentView addSubview:control];
    [window makeFirstResponder:control];
    pump(^BOOL { return NSTextInputContext.currentInputContext == control.inputContext
        && [control.inputContext.selectedKeyboardInputSource isEqual:KOREAN_2SET]; });
    if (focusedTrace) {
        backspaceTrace(window, control, region);
        traceDeadline = nil;
        NSDate *cleanupDeadline = [NSDate dateWithTimeIntervalSinceNow:5];
        check(sp_input_source_select(previousSource.UTF8String), @"the previous input source is restored");
        check(pumpUntil(^BOOL { return [currentSourceID() isEqual:previousSource]; }, cleanupDeadline),
            @"the previous input source is active before cleanup ends");
        sp_region_close(region);
        [window close];
        [window release];
        if (previousApp) {
            [previousApp activateWithOptions:0];
            check(pumpUntil(^BOOL { return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier
                == previousApp.processIdentifier; }, cleanupDeadline),
                @"the frontmost application is restored before cleanup ends");
        }
        return failures ? 1 : 0;
    }
    NSUInteger (^controlAnswered)(void) = ^NSUInteger {
        return [control.calls indexesOfObjectsPassingTest:^BOOL(NSString *call, NSUInteger index, BOOL *stop) {
            return ![call hasPrefix:@"key("];
        }].count;
    };
    typeDddHangul(window, control.inputContext, controlAnswered);
    typeKey(window, @"Enter", controlAnswered);
    check([control.string isEqual:@"ddd한글 \n"],
        [NSString stringWithFormat:@"control: an AppKit text view receives ddd한글 through the injected keys (text %@, calls %@)",
            control.string, control.calls]);
    printf("MEASURE: text view calls for ddd한글 Space Enter: %s\n", [control.calls componentsJoinedByString:@"; "].UTF8String);
    // The input method remembers the position of the syllable being composed and commits again at that position on an input source switch, so the composition is ended before the document is cleared.
    [control.inputContext discardMarkedText];
    control.string = @"";
    [control.calls removeAllObjects];
    typeSwitchedSyllable(window, control.inputContext, controlAnswered);
    typeKey(window, @"Enter", controlAnswered);
    check([control.string isEqual:@"한 \n"],
        [NSString stringWithFormat:@"control: an AppKit text view receives the first syllable after a switch and a space (text %@, calls %@)",
            control.string, control.calls]);
    printf("MEASURE: text view calls for a switch, 한 Space Enter: %s\n", [control.calls componentsJoinedByString:@"; "].UTF8String);
    // V5-8: An injected named key arrives at the input method through the same path as a physical key. The input method handles Backspace during composition (U+D55C to U+D558).
    [control.inputContext discardMarkedText];
    control.string = @"";
    [control.calls removeAllObjects];
    selectSource(ABC, control.inputContext);
    selectSource(KOREAN_2SET, control.inputContext);
    for (NSString *key in @[@"g", @"k", @"s", @"Backspace"]) typeKey(window, key, controlAnswered);
    check([control.string isEqual:@"하"],
        [NSString stringWithFormat:@"control: an injected Backspace during a composition reaches the input method and leaves 하 (text %@, calls %@)",
            control.string, control.calls]);
    // F8: Escape during composition makes the input method end the composition. First measures the document that the control leaves.
    [control.inputContext discardMarkedText];
    control.string = @"";
    [control.calls removeAllObjects];
    selectSource(ABC, control.inputContext);
    selectSource(KOREAN_2SET, control.inputContext);
    for (NSString *key in @[@"g", @"k", @"s", @"Escape"]) typeKey(window, key, controlAnswered);
    check([control.string isEqual:@"한"] && !control.hasMarkedText,
        [NSString stringWithFormat:@"control: an injected Escape during a composition ends it and leaves 한 (text %@, marked %d, calls %@)",
            control.string, control.hasMarkedText, control.calls]);
    [control removeFromSuperview];

    // Control: records how the input method works with a minimal input client without a document.
    SPMinimalClient *minimal = [[[SPMinimalClient alloc] initWithFrame:NSMakeRect(300, 60, 150, 40)] autorelease];
    minimal.calls = [NSMutableArray array];
    minimal.committed = [NSMutableString string];
    [window.contentView addSubview:minimal];
    [window makeFirstResponder:minimal];
    pump(^BOOL { return NSTextInputContext.currentInputContext == minimal.inputContext
        && [minimal.inputContext.selectedKeyboardInputSource isEqual:KOREAN_2SET]; });
    typeDddHangul(window, minimal.inputContext, ^NSUInteger { return minimal.calls.count; });
    // Only measured values are recorded. This client is not product code; it shows the callbacks that the input method sends when there is no document.
    printf("MEASURE: minimal client committed %s, marked %s, calls %s\n", minimal.committed.UTF8String,
        minimal.marked.UTF8String, [minimal.calls componentsJoinedByString:@"; "].UTF8String);
    [minimal removeFromSuperview];

    // Control: checks whether a plain NSView client holding a document produces the same document as the text view in the same order.
    SPDocumentClient *plain = [[[SPDocumentClient alloc] initWithFrame:NSMakeRect(300, 60, 150, 40)] autorelease];
    plain.document = [NSMutableString string];
    plain.marked = NSMakeRange(NSNotFound, 0);
    plain.selected = NSMakeRange(0, 0);
    [window.contentView addSubview:plain];
    [window makeFirstResponder:plain];
    pump(^BOOL { return NSTextInputContext.currentInputContext == plain.inputContext
        && [plain.inputContext.selectedKeyboardInputSource isEqual:KOREAN_2SET]; });
    __block NSUInteger plainEdits = 0;
    __block NSString *plainSeen = @"";
    typeDddHangul(window, plain.inputContext, ^NSUInteger {
        if (![plain.document isEqual:plainSeen] || plain.hasMarkedText) { plainSeen = [[plain.document copy] autorelease]; plainEdits++; }
        return plainEdits;
    });
    check([plain.document isEqual:@"ddd한글 "] && !plain.hasMarkedText,
        [NSString stringWithFormat:@"plain NSView client with its own document: ddd한글 Space produces ddd한글 and a space (document %@)", plain.document]);
    [plain removeFromSuperview];
    sp_region_focus(region);
    check(pump(^BOOL { return NSTextInputContext.currentInputContext == context; }),
        @"the region's input context is current again");
    [events removeAllObjects];

    // User report: typing ddd followed by the Hangul word U+D55C U+AE00 yields ddd followed by only U+AE00. The committed input of the image region must be exactly ddd followed by the whole word.
    [events removeAllObjects];
    NSUInteger (^regionAnswered)(void) = ^NSUInteger { return events.count; };
    typeDddHangul(window, context, regionAnswered);
    // F8-16: When Space ends the composition, the space is committed without a next key, and the composition string must be empty.
    NSString *committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    NSString *preedit = [valuesOfType(@"compose", 0) lastObject] ?: @"";
    check([committed isEqual:@"ddd한글 "] && [preedit isEqual:@""],
        [NSString stringWithFormat:@"image region: ddd한글 and a space are committed before any further key (committed %@, preedit '%@', events %@)",
            committed, preedit, events]);
    typeKey(window, @"Enter", regionAnswered);
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    NSDictionary *last = events.lastObject;
    check([committed isEqual:@"ddd한글 "] && [last[@"type"] isEqual:@"key"] && [last[@"key"] isEqual:@"Enter"],
        [NSString stringWithFormat:@"image region: ddd한글 and a space are committed exactly once before Enter (committed %@, events %@)",
            committed, events]);

    // Also when the syllable U+C740 is composed after U+AE00, Space must commit the Hangul and the space without a next key.
    [events removeAllObjects];
    selectSource(ABC, context);
    for (NSString *key in @[@"d", @"d", @"d"]) typeKey(window, key, regionAnswered);
    selectSource(KOREAN_2SET, context);
    for (NSString *key in @[@"g", @"k", @"s", @"r", @"m", @"f", @"d", @"m", @"s", @"Space"]) {
        typeKey(window, key, regionAnswered);
    }
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    preedit = [valuesOfType(@"compose", 0) lastObject] ?: @"";
    check([committed isEqual:@"ddd한글은 "] && [preedit isEqual:@""],
        [NSString stringWithFormat:@"image region: ddd한글은 and Space commit before another key (committed %@, preedit '%@', events %@)",
            committed, preedit, events]);
    typeKey(window, @"Enter", regionAnswered);

    // Also checks the callback in which the last syllable and Space remain in a single insert, as observed in Tauri.
    [events removeAllObjects];
    NSUInteger batchStart = ((NSTextView *)region).textStorage.length;
    [(id<NSTextInputClient>)region insertText:@"은" replacementRange:NSMakeRange(NSNotFound, 0)];
    [(id<NSTextInputClient>)region insertText:@"은 " replacementRange:NSMakeRange(batchStart, 1)];
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    preedit = [valuesOfType(@"compose", 0) lastObject] ?: @"";
    check([committed isEqual:@"은 "] && [preedit isEqual:@""],
        [NSString stringWithFormat:@"image region: a batched final syllable and Space commit before another key (committed %@, preedit '%@', events %@)",
            committed, preedit, events]);
    [(id<NSTextInputClient>)region doCommandBySelector:@selector(insertNewline:)];

    // Space after the first syllable composed with a replacement range right after the switch must also be committed without a next key.
    [events removeAllObjects];
    typeSwitchedSyllable(window, context, regionAnswered);
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    preedit = [valuesOfType(@"compose", 0) lastObject] ?: @"";
    check([committed isEqual:@"한 "] && [preedit isEqual:@""],
        [NSString stringWithFormat:@"image region: the first syllable after a switch and a space are committed before any further key (committed %@, preedit '%@', events %@)",
            committed, preedit, events]);
    typeKey(window, @"Enter", regionAnswered);

    // F8-16-1: A digit after a syllable is also committed together with the syllable without a next key.
    [events removeAllObjects];
    selectSource(ABC, context);
    selectSource(KOREAN_2SET, context);
    for (NSString *key in @[@"g", @"k", @"s", @"1"]) typeKey(window, key, regionAnswered);
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    preedit = [valuesOfType(@"compose", 0) lastObject] ?: @"";
    check([committed isEqual:@"한1"] && [preedit isEqual:@""],
        [NSString stringWithFormat:@"image region: a digit after a syllable is committed with it before any further key (committed %@, preedit '%@', events %@)",
            committed, preedit, events]);
    typeKey(window, @"Enter", regionAnswered);

    // F8-20: Backspace during composition makes the input method edit the syllable (U+D55C to U+D558) and sends no key or string to the PTY.
    [events removeAllObjects];
    selectSource(ABC, context);
    selectSource(KOREAN_2SET, context);
    for (NSString *key in @[@"g", @"k", @"s", @"Backspace"]) typeKey(window, key, regionAnswered);
    NSUInteger (^keyCount)(NSString *) = ^NSUInteger(NSString *name) {
        return [events indexesOfObjectsPassingTest:^BOOL(NSDictionary *event, NSUInteger index, BOOL *stop) {
            return [event[@"type"] isEqual:@"key"] && [event[@"key"] isEqual:name];
        }].count;
    };
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    preedit = [valuesOfType(@"compose", 0) lastObject] ?: @"";
    check([preedit isEqual:@"하"] && committed.length == 0 && keyCount(@"Backspace") == 0,
        [NSString stringWithFormat:@"image region: Backspace during a composition edits it to 하 without PTY input (preedit '%@', committed '%@', events %@)",
            preedit, committed, events]);
    typeKey(window, @"Enter", regionAnswered);
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    NSDictionary *enter = events.lastObject;
    check([committed isEqual:@"하"] && [enter[@"key"] isEqual:@"Enter"] && keyCount(@"Enter") == 1,
        [NSString stringWithFormat:@"image region: Enter commits the edited syllable once and is reported after it (committed '%@', events %@)", committed, events]);
    // Without composition, Backspace is reported as a key.
    [events removeAllObjects];
    typeKey(window, @"Backspace", regionAnswered);
    check(keyCount(@"Backspace") == 1 && [valuesOfType(@"insert", 0) count] == 0,
        [NSString stringWithFormat:@"image region: Backspace without a composition is reported as a key (events %@)", events]);
    // Escape during composition commits the remaining composition once and then reports Escape as a key (docs/spec/persistent-services.md).
    [events removeAllObjects];
    selectSource(ABC, context);
    selectSource(KOREAN_2SET, context);
    for (NSString *key in @[@"g", @"k", @"s", @"Escape"]) typeKey(window, key, regionAnswered);
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    NSUInteger inserted = [events indexOfObjectPassingTest:^BOOL(NSDictionary *event, NSUInteger index, BOOL *stop) {
        return [event[@"type"] isEqual:@"insert"];
    }];
    NSUInteger escaped = [events indexOfObjectPassingTest:^BOOL(NSDictionary *event, NSUInteger index, BOOL *stop) {
        return [event[@"type"] isEqual:@"key"] && [event[@"key"] isEqual:@"Escape"];
    }];
    check([committed isEqual:@"한"] && keyCount(@"Escape") == 1 && inserted < escaped,
        [NSString stringWithFormat:@"image region: Escape during a composition commits it once and is reported after it (committed '%@', events %@)",
            committed, events]);

    check(sp_input_source_select(previousSource.UTF8String), @"the previous input source is restored");
    sp_region_close(region);
    [window close];
    [window release];
    if (previousApp) [previousApp activateWithOptions:0];
    return failures ? 1 : 0;
}}
