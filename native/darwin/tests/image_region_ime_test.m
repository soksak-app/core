// 활성 키 창의 그림 영역에 물리 키를 보내 macOS 한국어 2벌식 입력기의 조합과 확정을 검사한다.
//
// 입력기는 키 창의 활성 입력 컨텍스트만 처리하므로 이 검사는 애플리케이션을 활성화해 포커스를 가져가고,
// 검사 동안 선택된 입력 소스를 한국어 2벌식으로 바꾼다. 끝나면 이전 입력 소스와 이전 앱을 되돌린다.
// make test 에 포함하지 않고 make test-activation 으로만 실행한다. 한국어 2벌식이 켜져 있지 않으면 실패한다.
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "image_region.h"
#import "input_inject.h"
#import "webview_geometry.h"

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

static TISInputSourceRef copySource(NSString *identifier) {
    NSArray *sources = (NSArray *)TISCreateInputSourceList(
        (CFDictionaryRef)@{(id)kTISPropertyInputSourceID: identifier}, false);
    TISInputSourceRef source = sources.count ? (TISInputSourceRef)CFRetain(sources[0]) : NULL;
    [sources release];
    return source;
}

static NSString *currentSourceID(void) {
    TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
    NSString *identifier = [[(NSString *)TISGetInputSourceProperty(current, kTISPropertyInputSourceID) copy] autorelease];
    CFRelease(current);
    return identifier;
}

// 물리 키 하나를 누르고 뗀다. 입력기가 응답할 이벤트 수를 늘리지 않으면 실패로 기록한다.
static void press(NSWindow *window, const char *key) {
    NSUInteger before = events.count;
    check(sp_input_key(window, key, NULL, 0, true) && sp_input_key(window, key, NULL, 0, false),
        [NSString stringWithFormat:@"the %s key is delivered to the key window", key]);
    BOOL answered = pump(^BOOL { return events.count > before; });
    check(answered, [NSString stringWithFormat:@"the input method answers the %s key (events %@)", key, events]);
}

// 물리 키 하나를 하드웨어 입력과 같은 원본 상태로 만들어 WindowServer 를 거쳐 이 프로세스에 보낸다.
static void postKeyToProcess(CGKeyCode code) {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(source, code, down);
        CGEventPostToPid(getpid(), event);
        CFRelease(event);
    }
    CFRelease(source);
}

static NSArray *valuesOfType(NSString *type, NSUInteger from) {
    NSMutableArray *values = [NSMutableArray array];
    for (NSUInteger i = from; i < events.count; i++) {
        if ([events[i][@"type"] isEqual:type]) [values addObject:events[i][@"text"] ?: NSNull.null];
    }
    return values;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    events = [NSMutableArray new];

    TISInputSourceRef korean = copySource(KOREAN_2SET);
    if (!korean) {
        fprintf(stderr, "FAIL: the %s input source is not enabled\n", KOREAN_2SET.UTF8String);
        return 1;
    }
    TISInputSourceRef previousSource = TISCopyCurrentKeyboardInputSource();
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

    check(TISSelectInputSource(korean) == noErr, @"Korean 2-Set is selected");
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
    // 대조: AppKit 기본 텍스트 뷰가 두 전달 경로에서 조합하는지 확인한다. 조합하지 못하는 경로는 입력기에 닿지 않는다.
    // window: -[NSWindow sendEvent:] 로 전달한다(endpoint 주입기와 같은 경로).
    // pid: CGEventPostToPid 로 WindowServer 를 거쳐 이 프로세스에만 전달한다.
    for (NSString *route in @[@"window", @"pid"]) {
        NSTextView *control = [[[NSTextView alloc] initWithFrame:NSMakeRect(300, 10, 150, 40)] autorelease];
        [window.contentView addSubview:control];
        [window makeFirstResponder:control];
        pump(^BOOL { return NSTextInputContext.currentInputContext == control.inputContext
            && [control.inputContext.selectedKeyboardInputSource isEqual:KOREAN_2SET]; });
        for (NSNumber *code in @[@1, @40]) {
            if ([route isEqual:@"window"]) {
                NSString *key = code.intValue == 1 ? @"s" : @"k";
                sp_input_key(window, key.UTF8String, NULL, 0, true);
                sp_input_key(window, key.UTF8String, NULL, 0, false);
            } else {
                postKeyToProcess(code.unsignedShortValue);
            }
            pump(^BOOL { return control.string.length > 0; });
        }
        pump(^BOOL { return control.hasMarkedText && [control.string isEqual:@"나"]; });
        check(control.hasMarkedText && [control.string isEqual:@"나"],
            [NSString stringWithFormat:@"control (%@ route): an AppKit text view composes 나 (marked %d, text %@)",
                route, control.hasMarkedText, control.string]);
        [control removeFromSuperview];
    }
    sp_region_focus(region);
    check(pump(^BOOL { return NSTextInputContext.currentInputContext == context; }),
        @"the region's input context is current again");
    [events removeAllObjects];

    // ANSI s, k 는 2벌식에서 ㄴ, ㅏ 다. 입력기는 조합 중인 음절을 marked text 로 보고한다.
    press(window, "s");
    press(window, "k");
    NSArray *composes = valuesOfType(@"compose", 0);
    check([composes containsObject:@"ㄴ"] && [composes.lastObject isEqual:@"나"],
        [NSString stringWithFormat:@"the input method composes ㄴ then 나 (compose %@)", composes]);
    check(valuesOfType(@"insert", 0).count == 0,
        [NSString stringWithFormat:@"no text is committed during composition (events %@)", events]);

    // Space 는 조합을 확정하고 공백을 입력한다. 음절은 정확히 한 번 확정된다.
    NSUInteger beforeCommit = events.count;
    press(window, "Space");
    pump(^BOOL { return valuesOfType(@"insert", beforeCommit).count >= 2; });
    NSArray *inserts = valuesOfType(@"insert", beforeCommit);
    check([inserts isEqualToArray:@[@"나", @" "]],
        [NSString stringWithFormat:@"Space commits 나 once and then inserts a space (inserts %@, events %@)", inserts, events]);

    TISSelectInputSource(previousSource);
    CFRelease(previousSource);
    CFRelease(korean);
    sp_region_close(region);
    [window close];
    [window release];
    if (previousApp) [previousApp activateWithOptions:0];
    return failures ? 1 : 0;
}}
