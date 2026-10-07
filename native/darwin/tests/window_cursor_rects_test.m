// 창 구성이 창의 cursor rect 관리를 끄고, 창에 흔히 일어나는 변경 뒤에도 꺼진 채로 두는지 검사한다. 콘텐츠 뷰는
// Tauri 의 tao 처럼 자기 영역 전체에 화살표 cursor rect 를 둔다(docs/features.md F95). 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void spin(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (until.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:
            [NSDate dateWithTimeIntervalSinceNow:MIN(0.01, until.timeIntervalSinceNow)]];
    }
}

// tao 의 TaoView 처럼 자기 영역 전체에 화살표 cursor rect 를 두는 콘텐츠 뷰.
@interface SPArrowContentView : NSView
@end
@implementation SPArrowContentView
- (void)resetCursorRects {
    [self addCursorRect:self.bounds cursor:NSCursor.arrowCursor];
}
@end

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: the window composition keeps cursor rectangles off\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(80, 80, 400, 300)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO] autorelease];
    [window setReleasedWhenClosed:NO];
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.contentView = [[[SPArrowContentView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderFrontRegardless];
    spin(0.2);
    check(window.areCursorRectsEnabled, @"a new window manages cursor rectangles");

    void *surface = sp_surface_create(main);
    check(surface != NULL, @"the window composition is created");
    check(!window.areCursorRectsEnabled, @"the window composition turns cursor rectangles off");

    NSArray<NSArray *> *changes = @[
        @[@"a resize", ^{ [window setFrame:NSMakeRect(80, 80, 520, 360) display:YES]; }],
        @[@"a title change", ^{ window.title = @"changed"; }],
        @[@"an order out and in", ^{ [window orderOut:nil]; [window orderFrontRegardless]; }],
        @[@"making the window key", ^{ [window makeKeyWindow]; }],
        @[@"invalidating the cursor rectangles of the content view", ^{ [window invalidateCursorRectsForView:window.contentView]; }],
        @[@"a new subview", ^{ [window.contentView addSubview:[[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)] autorelease]]; }],
    ];
    for (NSArray *change in changes) {
        ((void (^)(void))change[1])();
        spin(0.2);
        check(!window.areCursorRectsEnabled, [NSString stringWithFormat:@"cursor rectangles stay off after %@", change[0]]);
    }
    check(!NSApp.isActive, @"the check does not activate the application");
    sp_surface_close(surface);
    [window close];
    fprintf(stderr, "%s: the window composition keeps cursor rectangles off (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
