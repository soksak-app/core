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
    [main addSubview:top];
    [top setValue:@NO forKey:@"drawsBackground"];
    top.underPageBackgroundColor = NSColor.clearColor;

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
    check([views[0][@"view"] unsignedLongLongValue] == (uintptr_t)main && [views[1][@"view"] unsignedLongLongValue] == (uintptr_t)top,
        @"webviews are listed in drawing order with the main page first");
    NSDictionary *upper = views[1];
    // WKWebView 는 뒤집힌 좌표계라 하위 뷰의 frame 이 곧 콘텐츠 영역 왼쪽 위 기준이다.
    check(main.isFlipped, @"the main webview is a flipped view");
    check([upper[@"x"] doubleValue] == 100 && [upper[@"y"] doubleValue] == 50 && [upper[@"width"] doubleValue] == 200
        && [upper[@"height"] doubleValue] == 100, [NSString stringWithFormat:@"child webview frame in window coordinates: %@", upper]);
    check(![upper[@"draws"] boolValue] && [upper[@"alpha"] doubleValue] == 0 && [views[0][@"draws"] boolValue],
        @"background drawing and under-page alpha are reported per webview");

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
    check(!NSApp.isActive, @"application stays inactive");
    [window close];
    return failures ? 1 : 0;
}}
