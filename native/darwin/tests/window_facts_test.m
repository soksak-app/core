// 창 상태 함수가 화면·창 좌표, 웹뷰 순서, 히트 테스트, 이동을 올바르게 보고하는지 검사한다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static id parse(char *text) {
    if (!text) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil];
    sp_facts_free(text);
    return value;
}

// 창 서버의 가림 상태 변경은 AppKit 이벤트로 도착한다. 창과 화면 변경 이벤트만 꺼내 보낸다. 애플리케이션
// 활성화 이벤트는 꺼내지 않는다(활성화는 검사 프로세스를 활성으로 만든다).
static void pumpOcclusion(void) {
    NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
        inMode:NSDefaultRunLoopMode dequeue:NO];
    if (event && event.subtype != NSEventSubtypeApplicationActivated && event.subtype != NSEventSubtypeApplicationDeactivated) {
        [NSApp sendEvent:[NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:nil inMode:NSDefaultRunLoopMode dequeue:YES]];
    }
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
    WKWebView *top = [[WKWebView alloc] initWithFrame:NSMakeRect(100, 50, 200, 100)];
    window.contentView = main;
    check(sp_window_set_main_webview(window, main), @"the app DOM is explicitly registered");
    [main addSubview:top];
    check(!sp_window_set_main_webview(window, top), @"another webview cannot replace the registered app DOM");
    [top setValue:@NO forKey:@"drawsBackground"];
    top.underPageBackgroundColor = NSColor.clearColor;

    [window makeFirstResponder:top];
    NSDictionary *responderFacts = parse(sp_window_facts(window));
    check([responderFacts[@"responder"][@"webview"] unsignedLongLongValue] == (uintptr_t)top,
        [NSString stringWithFormat:@"the first responder's webview is reported: %@", responderFacts[@"responder"]]);
    [window makeFirstResponder:main];
    responderFacts = parse(sp_window_facts(window));
    check([responderFacts[@"responder"][@"webview"] unsignedLongLongValue] == (uintptr_t)main
        && [responderFacts[@"responder"][@"class"] length] > 0
        && responderFacts[@"responder"][@"main"] == (id)kCFBooleanTrue,
        [NSString stringWithFormat:@"a responder change is reported with its class: %@", responderFacts[@"responder"]]);
    // 애플리케이션 메뉴는 하위 메뉴마다 제목과 항목의 제목, 단축키를 보고한다. 구분선은 뺀다.
    NSMenu *mainMenu = [[[NSMenu alloc] initWithTitle:@""] autorelease];
    NSMenuItem *viewItem = [[[NSMenuItem alloc] initWithTitle:@"View" action:nil keyEquivalent:@""] autorelease];
    NSMenu *viewMenu = [[[NSMenu alloc] initWithTitle:@"View"] autorelease];
    [viewMenu addItemWithTitle:@"Zoom In" action:nil keyEquivalent:@"+"];
    [viewMenu addItem:NSMenuItem.separatorItem];
    NSMenuItem *full = [viewMenu addItemWithTitle:@"Toggle Full Screen" action:nil keyEquivalent:@"f"];
    full.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
    viewItem.submenu = viewMenu;
    [mainMenu addItem:viewItem];
    NSApp.mainMenu = mainMenu;
    NSArray *menus = parse(sp_menu_items());
    check([menus isEqual:@[@{ @"title": @"View", @"items": @[
            @{ @"title": @"Zoom In", @"key": @"cmd++" },
            @{ @"title": @"Toggle Full Screen", @"key": @"ctrl+cmd+f" } ] }]],
        [NSString stringWithFormat:@"the application menu is reported with titles and keys: %@", menus]);

    __block BOOL performed = NO;
    NSMenuItem *zoomIn = [viewMenu itemWithTitle:@"Zoom In"];
    zoomIn.target = [NSBlockOperation blockOperationWithBlock:^{ performed = YES; }];
    zoomIn.action = @selector(main);
    check(sp_menu_select("View", "Zoom In") && performed, @"a menu item is performed by its menu and title");
    check(!sp_menu_select("View", "Missing") && !sp_menu_select("Missing", "Zoom In"), @"an unknown menu item is rejected");

    check(sp_window_move(window, 120, 80), @"move accepted");
    NSDictionary *facts = parse(sp_window_facts(window));
    CGFloat primary = NSMaxY(NSScreen.screens.firstObject.frame);
    check([facts[@"frame"][@"x"] doubleValue] == 120 && [facts[@"frame"][@"y"] doubleValue] == 80,
        [NSString stringWithFormat:@"the frame is reported at the moved top-left screen point: %@", facts[@"frame"]]);
    check(NSMaxY(window.frame) == primary - 80, @"the move places the frame top 80 points below the primary display top");
    check([facts[@"content"][@"width"] doubleValue] == 400 && [facts[@"content"][@"height"] doubleValue] == 300, @"content size");
    check(![facts[@"active"] boolValue] && ![facts[@"key"] boolValue], @"an inactive window is reported as not key and not active");
    check([facts[@"children"] integerValue] == 0, @"no child windows");
    check([facts[@"controls"] count] == 3, @"three window buttons are reported");
    NSArray *views = facts[@"webviews"];
    check(views.count == 2, @"both webviews are reported");
    check([facts[@"appDomWebviews"] integerValue] == 2 && [facts[@"documentWebviews"] integerValue] == 0,
        @"an extra non-document webview is counted instead of reporting a constant app DOM count");
    check([views[0][@"view"] unsignedLongLongValue] == (uintptr_t)main && [views[1][@"view"] unsignedLongLongValue] == (uintptr_t)top,
        @"webviews are listed in drawing order with the main page first");
    NSDictionary *upper = views[1];
    // WKWebView 는 뒤집힌 좌표계라 하위 뷰의 frame 이 곧 콘텐츠 영역 왼쪽 위 기준이다.
    check(main.isFlipped, @"the main webview is a flipped view");
    check([upper[@"x"] doubleValue] == 100 && [upper[@"y"] doubleValue] == 50 && [upper[@"width"] doubleValue] == 200
        && [upper[@"height"] doubleValue] == 100, [NSString stringWithFormat:@"child webview frame in window coordinates: %@", upper]);
    check(![upper[@"draws"] boolValue] && [upper[@"alpha"] doubleValue] == 0 && [views[0][@"draws"] boolValue],
        @"background drawing and under-page alpha are reported per webview");
    check([views[0][@"near60fps"] isEqual:@NO] && [views[1][@"near60fps"] isEqual:@YES],
        [NSString stringWithFormat:@"registration lets only the app DOM render at the display rate: main %@, other %@",
            views[0][@"near60fps"], views[1][@"near60fps"]]);
    check(upper[@"focused"] != nil, @"document webview focus is reported");

    char *raw = sp_window_hit(window, 10, 10);
    check(strstr(raw, "\"main\":true") != NULL, [NSString stringWithFormat:@"main is a JSON boolean: %s", raw]);
    sp_facts_free(raw);
    NSDictionary *hit = parse(sp_window_hit(window, 150, 100));
    check([hit[@"view"] unsignedLongLongValue] == (uintptr_t)top && ![hit[@"main"] boolValue], @"a point inside the child webview hits it");
    hit = parse(sp_window_hit(window, 150, 200));
    check([hit[@"view"] unsignedLongLongValue] == (uintptr_t)main && [hit[@"main"] boolValue], @"a point outside it hits the main webview");

    NSArray *screens = parse(sp_screens());
    check(screens.count == NSScreen.screens.count && [screens[0][@"x"] doubleValue] == 0 && [screens[0][@"y"] doubleValue] == 0
        && [screens[0][@"scale"] doubleValue] >= 1, @"the primary display is reported at the screen origin with its scale");
    check(parse(sp_dock_items()) != nil, @"Dock items are reported as an array");
    check(!sp_dock_select("No such item"), @"an unknown Dock item is rejected");
    // 창을 화면에 보이거나 치우면 창 서버가 가림 상태를 바꾸고, 관찰은 그 변경마다 호출된다.
    NSWindow *observed = [[[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 200, 120)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [observed setReleasedWhenClosed:NO];
    __block int changes = 0;
    check(sp_window_observe_occlusion(observed, ^{ changes++; }), @"occlusion observation starts");
    check(!sp_window_observe_occlusion(NULL, ^{}), @"occlusion observation without a window is rejected");
    [observed orderFrontRegardless];
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:2];
    while (changes == 0 && [limit timeIntervalSinceNow] > 0) pumpOcclusion();
    check(changes > 0 && (observed.occlusionState & NSWindowOcclusionStateVisible) != 0,
        [NSString stringWithFormat:@"showing the window reports an occlusion change (%d changes)", changes]);
    int shown = changes;
    [observed orderOut:nil];
    limit = [NSDate dateWithTimeIntervalSinceNow:2];
    while (changes == shown && [limit timeIntervalSinceNow] > 0) pumpOcclusion();
    check(changes > shown, [NSString stringWithFormat:@"hiding the window reports an occlusion change (%d changes)", changes]);
    check(!NSApp.isActive, @"application stays inactive");
    [window close];
    return failures ? 1 : 0;
}}
