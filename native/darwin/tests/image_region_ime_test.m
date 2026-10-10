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
#import "image_region.h"
#import "input_inject.h"
#import "input_source.h"
#import "webview_geometry.h"

static NSString *const ABC = @"com.apple.keylayout.ABC";
static NSString *const KOREAN_2SET = @"com.apple.inputmethod.Korean.2SetKorean";

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
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
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
@end
@implementation SPRecordingTextView
- (void)insertText:(id)string replacementRange:(NSRange)range {
    [self.calls addObject:[NSString stringWithFormat:@"insert(%@, replace %@)",
        [string isKindOfClass:NSAttributedString.class] ? [string string] : string, NSStringFromRange(range)]];
    [super insertText:string replacementRange:range];
}
- (void)setMarkedText:(id)string selectedRange:(NSRange)selected replacementRange:(NSRange)range {
    [self.calls addObject:[NSString stringWithFormat:@"mark(%@, selected %@, replace %@)",
        [string isKindOfClass:NSAttributedString.class] ? [string string] : string,
        NSStringFromRange(selected), NSStringFromRange(range)]];
    [super setMarkedText:string selectedRange:selected replacementRange:range];
}
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    NSAttributedString *result = [super attributedSubstringForProposedRange:range actualRange:actual];
    [self.calls addObject:[NSString stringWithFormat:@"read(%@) -> %@", NSStringFromRange(range), result.string]];
    return result;
}
- (void)unmarkText {
    [self.calls addObject:@"unmark"];
    [super unmarkText];
}
- (void)doCommandBySelector:(SEL)selector {
    [self.calls addObject:NSStringFromSelector(selector)];
    [super doCommandBySelector:selector];
}
- (void)keyDown:(NSEvent *)event {
    [self.calls addObject:[NSString stringWithFormat:@"key(%@)", event.charactersIgnoringModifiers]];
    [super keyDown:event];
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

// tests/support/no_activation.m: this check activates the application in make test-activation.
void sp_test_declare_activation(void);

int main(void) { @autoreleasepool {
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
    // Escape during composition commits the remaining composition once and then reports Escape as a key (docs/spec/terminal-runtime.md).
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
