// 창 단추 배치가 보이는 단추 영역의 세로 중앙을 요청한 위치에 두고, 배치할 수 없는 창을
// 실패로 보고하는지 검사한다. 애플리케이션을 활성화하지 않는다.
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

static void expectAt(NSWindow *window, double x, double centre, NSString *when) {
    double area[4] = {0, 0, 0, 0};
    windowControls(window, area);
    double middle = area[1] + area[3] / 2;
    check(fabs(area[0] - x) <= 0.25 && fabs(middle - centre) <= 0.25,
        [NSString stringWithFormat:@"%@: buttons start at x %.2f and are centred at y %.2f (visible area %.2f, %.2f, %.2f x %.2f)",
            when, x, centre, area[0], area[1], area[2], area[3]]);
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = hostLikeWindow();
    [window orderBack:nil];
    check(windowPlaceControls(window, 12, 22.5), @"placement accepted");
    expectAt(window, 12, 22.5, @"after placement");

    [window setContentSize:NSMakeSize(700, 450)];
    expectAt(window, 12, 22.5, @"after a resize");

    check(windowPlaceControls(window, 20, 30), @"a second placement accepted");
    expectAt(window, 20, 30, @"after moving the placement");

    NSWindow *plain = [[[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO] autorelease];
    [plain setReleasedWhenClosed:NO];
    check(!windowPlaceControls(plain, 12, 22.5), @"a window without standard buttons is reported as not placed");

    [window close];
    [plain close];
    return failures ? 1 : 0;
}}
