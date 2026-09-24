// 활성 키 창에 물리 키를 보내 macOS 한국어 2벌식 입력기의 조합 결과를 검사한다.
//
// 입력기는 키 창의 활성 입력 컨텍스트만 처리하므로 이 검사는 애플리케이션을 활성화해 포커스를 가져가고,
// 검사 동안 입력 소스를 영문과 한국어 2벌식으로 바꾼다. 끝나면 이전 입력 소스와 이전 앱을 되돌린다.
// make test 에 포함하지 않고 make test-activation 으로만 실행한다. 한국어 2벌식이 켜져 있지 않으면 실패한다.
// 키는 endpoint 주입기와 같은 -[NSWindow sendEvent:] 경로로 보낸다. AppKit 텍스트 뷰 대조군이 이 경로로
// 올바른 문서를 만드는지 먼저 확인하고, 문서가 없는 최소 입력 클라이언트의 콜백을 측정값으로 기록한 뒤,
// 그림 영역이 사용자 보고 순서(ddd 뒤 한글)를 정확히 확정하는지 검사한다.
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

// 앱 이벤트를 꺼내 처리하며 기다린다. 활성화와 입력기 응답은 이벤트로 도착한다.
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

// 대조군 텍스트 뷰. 입력기가 보낸 콜백과 범위를 그대로 기록한다.
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

// 문서를 갖지 않는 최소 입력 클라이언트. 확정 문자열을 보관하지 않고 조합 문자열만 가진다.
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

// 문서를 스스로 가진 일반 NSView 입력 클라이언트. NSTextView 없이 입력기의 교체 범위를 문서에 적용한다.
// 그림 영역의 NSTextView 상위 클래스가 필요한지 같은 순서로 비교하는 대조군이다(F8-9).
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

// 사용자가 보고한 순서를 입력한다. 영문 입력 소스로 ddd 를 치고 한국어 2벌식으로 바꿔 한글(g k s r m f)과
// Space 를 친다. 키마다 answered 가 늘어날 때까지 기다린다.
static void typeKey(NSWindow *window, NSString *key, NSUInteger (^answered)(void)) {
    NSUInteger before = answered();
    BOOL sent = sp_input_key(window, key.UTF8String, NULL, 0, true) && sp_input_key(window, key.UTF8String, NULL, 0, false);
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

// 입력 소스 전환 직후 첫 음절(한)과 Space 를 친다. 입력기는 이 음절을 교체 범위로 조합한다.
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

// tests/support/no_activation.m: 이 검사는 make test-activation 에서 앱을 활성화한다.
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
    // 키를 보내기 전에 영역의 입력 컨텍스트가 한국어 2벌식을 선택했는지 기다린다.
    NSTextInputContext *context = ((NSView *)region).inputContext;
    check(pump(^BOOL { return NSTextInputContext.currentInputContext == context
            && [context.selectedKeyboardInputSource isEqual:KOREAN_2SET]; }),
        [NSString stringWithFormat:@"the region's input context is current and selects Korean 2-Set (current %d, selected %@)",
            NSTextInputContext.currentInputContext == context, context.selectedKeyboardInputSource]);
    // 대조: AppKit 기본 텍스트 뷰가 같은 경로(-[NSWindow sendEvent:], endpoint 주입기와 같다)로 받은 키를
    // 올바른 문서로 조합하는지 확인한다. 전환 직후 입력기는 확정한 글자를 교체 범위로 고쳐 쓰므로
    // marked 상태가 아니라 최종 문서를 비교한다.
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
    // 입력기는 조합하던 음절의 위치를 기억하고 입력 소스 전환 때 그 위치에 다시 확정하므로, 문서를 비우기 전에 조합을 끝낸다.
    [control.inputContext discardMarkedText];
    control.string = @"";
    [control.calls removeAllObjects];
    typeSwitchedSyllable(window, control.inputContext, controlAnswered);
    typeKey(window, @"Enter", controlAnswered);
    check([control.string isEqual:@"한 \n"],
        [NSString stringWithFormat:@"control: an AppKit text view receives the first syllable after a switch and a space (text %@, calls %@)",
            control.string, control.calls]);
    printf("MEASURE: text view calls for a switch, 한 Space Enter: %s\n", [control.calls componentsJoinedByString:@"; "].UTF8String);
    // V5-8: 주입한 이름 있는 키는 물리 키와 같은 경로로 입력기에 도착한다. 조합 중 Backspace 는 입력기가 처리한다(한 → 하).
    [control.inputContext discardMarkedText];
    control.string = @"";
    [control.calls removeAllObjects];
    selectSource(ABC, control.inputContext);
    selectSource(KOREAN_2SET, control.inputContext);
    for (NSString *key in @[@"g", @"k", @"s", @"Backspace"]) typeKey(window, key, controlAnswered);
    check([control.string isEqual:@"하"],
        [NSString stringWithFormat:@"control: an injected Backspace during a composition reaches the input method and leaves 하 (text %@, calls %@)",
            control.string, control.calls]);
    [control removeFromSuperview];

    // 대조: 문서가 없는 최소 입력 클라이언트에서 입력기가 쓰는 방식을 기록한다.
    SPMinimalClient *minimal = [[[SPMinimalClient alloc] initWithFrame:NSMakeRect(300, 60, 150, 40)] autorelease];
    minimal.calls = [NSMutableArray array];
    minimal.committed = [NSMutableString string];
    [window.contentView addSubview:minimal];
    [window makeFirstResponder:minimal];
    pump(^BOOL { return NSTextInputContext.currentInputContext == minimal.inputContext
        && [minimal.inputContext.selectedKeyboardInputSource isEqual:KOREAN_2SET]; });
    typeDddHangul(window, minimal.inputContext, ^NSUInteger { return minimal.calls.count; });
    // 측정값만 기록한다. 이 클라이언트는 제품 코드가 아니며, 문서가 없을 때 입력기가 보내는 콜백을 보여 준다.
    printf("MEASURE: minimal client committed %s, marked %s, calls %s\n", minimal.committed.UTF8String,
        minimal.marked.UTF8String, [minimal.calls componentsJoinedByString:@"; "].UTF8String);
    [minimal removeFromSuperview];

    // 대조: 문서를 가진 일반 NSView 클라이언트가 같은 순서에서 텍스트 뷰와 같은 문서를 만드는지 본다.
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

    // 사용자 보고: ddd한글 을 치면 ddd글 이 된다. 그림 영역의 확정 입력은 정확히 ddd한글 이어야 한다.
    [events removeAllObjects];
    NSUInteger (^regionAnswered)(void) = ^NSUInteger { return events.count; };
    typeDddHangul(window, context, regionAnswered);
    // F8-16: Space 가 조합을 끝내면 다음 키 없이 공백까지 확정되고 조합 문자열이 비어야 한다.
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

    // 전환 직후 교체 범위로 조합한 첫 음절 뒤의 Space 도 다음 키 없이 확정되어야 한다.
    [events removeAllObjects];
    typeSwitchedSyllable(window, context, regionAnswered);
    committed = [valuesOfType(@"insert", 0) componentsJoinedByString:@""];
    preedit = [valuesOfType(@"compose", 0) lastObject] ?: @"";
    check([committed isEqual:@"한 "] && [preedit isEqual:@""],
        [NSString stringWithFormat:@"image region: the first syllable after a switch and a space are committed before any further key (committed %@, preedit '%@', events %@)",
            committed, preedit, events]);
    typeKey(window, @"Enter", regionAnswered);

    // F8-16-1: 음절 뒤 숫자도 다음 키 없이 음절과 함께 확정된다.
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

    // F8-20: 조합 중 Backspace 는 입력기가 음절을 편집하며(한 → 하) PTY 에 키나 문자열을 보내지 않는다.
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
    // 조합이 없을 때 Backspace 는 키로 보고한다.
    [events removeAllObjects];
    typeKey(window, @"Backspace", regionAnswered);
    check(keyCount(@"Backspace") == 1 && [valuesOfType(@"insert", 0) count] == 0,
        [NSString stringWithFormat:@"image region: Backspace without a composition is reported as a key (events %@)", events]);

    check(sp_input_source_select(previousSource.UTF8String), @"the previous input source is restored");
    sp_region_close(region);
    [window close];
    [window release];
    if (previousApp) [previousApp activateWithOptions:0];
    return failures ? 1 : 0;
}}
