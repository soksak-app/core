// 페이지가 요청한 높이로 제목줄을 만들면 AppKit 이 그 높이의 세로 가운데에 창 단추를 두고, 제목 변경과
// 창 크기 변경 뒤에도 그 자리가 유지되는지 검사한다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "window_controls.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 두 호스트의 창과 같이 제목 표시줄을 숨기고 콘텐츠가 창 전체를 차지하는 창. 도구막대는 없다.
static NSWindow *hostLikeWindow(void) {
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 600, 400)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
            | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView
        backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    return window;
}

// 창 프레임과 콘텐츠 배치 영역의 차이로 잰 제목줄 높이와 windowTitlebarHeight 가 모두 row 이고,
// 단추 위와 아래의 여백이 같은지 검사한다.
static void expectCentred(NSWindow *window, double row, NSString *when) {
    double bar = window.frame.size.height - window.contentLayoutRect.size.height;
    double reported = windowTitlebarHeight(window);
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    double above = area[1];
    double below = row - (area[1] + area[3]);
    check(bar == row && reported == row && area[3] > 0 && fabs(above - below) <= 0.5,
        [NSString stringWithFormat:@"%@: the buttons are centred in the %.1fpt title bar "
            "(title bar %.1f, reported %.1f, buttons %.1f, above %.2f, below %.2f)",
            when, row, bar, reported, area[3], above, below]);
}

// 높이 설정이 실패하고 실패 문장이 expected 이며 제목줄이 그대로인지 검사한다.
static void expectRejected(NSWindow *window, double height, const char *expected, NSString *what) {
    double before = window.frame.size.height - window.contentLayoutRect.size.height;
    char *failure = NULL;
    bool set = windowSetTitlebarHeight(window, height, &failure);
    double after = window.frame.size.height - window.contentLayoutRect.size.height;
    check(!set && failure && strcmp(failure, expected) == 0 && after == before,
        [NSString stringWithFormat:@"%@ is rejected with \"%s\" and keeps the %.1fpt title bar (got %s, \"%s\", %.1fpt)",
            what, expected, before, set ? "set" : "rejected", failure ? failure : "no message", after]);
    free(failure);
}

static bool setHeight(NSWindow *window, double height) {
    char *failure = NULL;
    bool set = windowSetTitlebarHeight(window, height, &failure);
    if (!set) fprintf(stderr, "windowSetTitlebarHeight(%.1f): %s\n", height, failure);
    free(failure);
    return set;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = hostLikeWindow();
    [window orderBack:nil];

    // 프레임 글자 배율 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3 의 첫 행(app.css 의 --chrome-row)과 그 사이 값이다.
    // 마지막 두 값은 배율을 내릴 때 제목줄이 다시 낮아지는지 본다.
    const double rows[] = {40, 45, 54, 63, 72, 90, 108, 54, 40};
    for (size_t i = 0; i < sizeof rows / sizeof rows[0]; i++) {
        double row = rows[i];
        check(setHeight(window, row), [NSString stringWithFormat:@"the title bar takes the requested %.1fpt", row]);
        expectCentred(window, row, @"after the height is set");

        // 제목을 바꾸면 AppKit 이 단추를 다시 배치한다. 단추는 AppKit 의 것이므로 자리는 그대로다.
        window.title = [NSString stringWithFormat:@"renamed %zu", i];
        [window layoutIfNeeded];
        expectCentred(window, row, @"after a title change");

        NSSize size = i % 2 ? NSMakeSize(600, 400) : NSMakeSize(720, 480);
        [window setContentSize:size];
        [window layoutIfNeeded];
        expectCentred(window, row, @"after a resize");

        check(setHeight(window, row), @"setting the same height again succeeds");
        expectCentred(window, row, @"after the same height is set again");
    }
    check(window.toolbar == nil, @"the window needs no toolbar for its title bar height");

    // AppKit 은 0 이하의 높이를 사용자 지정 높이가 없다는 뜻으로 쓰고, 그 값으로는 다시 배치하지 않는다.
    expectRejected(window, 0, "title bar height must be a positive finite number", @"a zero height");
    expectRejected(window, -1, "title bar height must be a positive finite number", @"a negative height");
    expectRejected(window, NAN, "title bar height must be a positive finite number", @"a NaN height");
    expectRejected(window, INFINITY, "title bar height must be a positive finite number", @"an infinite height");

    NSWindow *plain = [[[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [plain setReleasedWhenClosed:NO];
    // 0 은 제목줄이 없는 창(전체 화면)의 높이이므로, 제목줄을 만들 수 없는 창은 음수로 알린다.
    check(windowTitlebarHeight(plain) < 0, @"a window without standard buttons reports that it cannot have a title bar");
    expectRejected(plain, 40, "the window has no standard buttons or content view for a title bar",
        @"a title bar height for a window without standard buttons");

    [window close];
    [plain close];
    return failures ? 1 : 0;
}}
