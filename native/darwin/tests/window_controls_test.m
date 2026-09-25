// 제목줄을 도구막대 높이로 만들면 AppKit 이 그 높이의 세로 가운데에 창 단추를 두고, 창 크기 변경과
// 제목 변경에도 그 자리가 유지되는지 검사한다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import "window_controls.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 두 호스트의 창과 같이 제목 표시줄을 숨기고 콘텐츠가 창 전체를 차지하는 창.
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

static void expectCentred(NSWindow *window, double row, NSString *when) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    double above = area[1];
    double below = row - (area[1] + area[3]);
    check(area[3] > 0 && fabs(above - below) <= 0.5,
        [NSString stringWithFormat:@"%@: the buttons are centred in the %.1fpt title bar (above %.2f, below %.2f)",
            when, row, above, below]);
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = hostLikeWindow();
    [window orderBack:nil];
    double plainRow = window.frame.size.height - window.contentLayoutRect.size.height;
    double row = windowUnifiedTitlebar(window);
    check(row > plainRow,
        [NSString stringWithFormat:@"the title bar is taller than the plain one (%.1fpt, plain %.1fpt)", row, plainRow]);
    expectCentred(window, row, @"after the title bar is set");

    [window setContentSize:NSMakeSize(700, 450)];
    expectCentred(window, row, @"after a resize");

    // 제목을 바꾸면 AppKit 이 단추를 다시 배치한다. 단추는 AppKit 의 것이므로 자리는 그대로다.
    window.title = @"renamed";
    [window layoutIfNeeded];
    expectCentred(window, row, @"after a title change");

    check(windowUnifiedTitlebar(window) == row, @"setting the title bar again reports the same height");

    NSWindow *plain = [[[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [plain setReleasedWhenClosed:NO];
    check(windowUnifiedTitlebar(plain) == 0, @"a window without standard buttons reports no title bar");

    // 페이지는 이 값으로 한 번 누름과 두 번 누름을 가른다. 시스템 설정 값이어야 한다.
    check(sp_double_click_interval() == NSEvent.doubleClickInterval && sp_double_click_interval() > 0,
        [NSString stringWithFormat:@"the double-click interval is the system value (%.3fs, system %.3fs)",
            sp_double_click_interval(), NSEvent.doubleClickInterval]);

    [window close];
    [plain close];
    return failures ? 1 : 0;
}}
