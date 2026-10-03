// 창과 웹뷰에 붙인 라이브러리 객체의 살아 있는 수가 붙일 때 늘고, 화면에 보이던 창과 웹뷰를 닫은 뒤 처음 값으로
// 돌아오는지 sp_window_objects_when 으로 검사한다. 프레임워크가 창을 닫는 동안 창을 자동 해제하는 경우를 창 하나를
// 자동 해제해 재현하고, AppKit 의 [NSApp run] 처럼 이벤트 하나마다 자동 해제 풀 하나를 쓰는 반복으로 이벤트를 처리한다.
// 화면에 보이던 창은 AppKit 이 닫기 애니메이션이 끝날 때까지 보유한다. 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "webview_input.h"
#import "window_facts.h"
#import "window_objects.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSString *describe(sp_window_objects counts) {
    return [NSString stringWithFormat:@"{windowCompositions %ld, surfaceHosts %ld, inputRegistrations %ld}",
        counts.windowCompositions, counts.surfaceHosts, counts.inputRegistrations];
}

static BOOL same(sp_window_objects left, sp_window_objects right) {
    return left.windowCompositions == right.windowCompositions && left.surfaceHosts == right.surfaceHosts &&
        left.inputRegistrations == right.inputRegistrations;
}

typedef struct {
    int calls;
    BOOL mainThread;
    bool reached;
    sp_window_objects counts;
} SPCounted;

static void counted(void *context, const sp_window_objects *counts, bool reached) {
    SPCounted *state = context;
    state->calls++;
    state->mainThread = NSThread.isMainThread;
    state->reached = reached;
    state->counts = *counts;
}

// done 이 불릴 때까지 이벤트를 하나씩 처리한다. 이벤트마다 자동 해제 풀 하나를 쓴다.
static void handleEventsUntilCounted(SPCounted *state) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
    while (state->calls == 0 && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:deadline inMode:NSDefaultRunLoopMode dequeue:YES];
            if (event) [NSApp sendEvent:event];
        }
    }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    sp_window_objects baseline = sp_window_objects_count();
    NSWindow *window;
    void *surface;
    WKWebView *attached;
    @autoreleasepool {
        window = [[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 600, 400)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        // 화면에 보이던 창을 닫아야 AppKit 의 닫기 애니메이션이 창을 보유한다. 활성화하지 않고 앞에 놓는다.
        [window orderFront:nil];
        window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        [window.contentView addSubview:main];
        check(sp_window_set_main_webview(window, main), @"the main webview is registered");
        check(webviewInputRegister(main), @"the main webview registers for input");
        surface = sp_surface_create(main);
        check(surface != NULL, @"a logical surface is created");
        attached = [[WKWebView alloc] initWithFrame:NSMakeRect(20, 20, 200, 120)];
        [window.contentView addSubview:attached positioned:NSWindowAbove relativeTo:nil];
        check(webviewInputRegister(attached), @"an attached surface webview registers for input");
        webviewAttachSurface(attached, main);
    }
    sp_window_objects open = sp_window_objects_count();
    sp_window_objects expected = {
        baseline.windowCompositions + 1, baseline.surfaceHosts + 2, baseline.inputRegistrations + 2,
    };
    check(same(open, expected), [NSString stringWithFormat:
        @"one window with a logical surface and an attached webview counts %@ (expected %@)", describe(open), describe(expected)]);

    SPCounted state = {0};
    // AppKit 의 이벤트 반복 하나. 창을 닫는 동안 자동 해제된 객체는 이 풀이 비워질 때 해제된다.
    @autoreleasepool {
        webviewInputUnregister(attached);
        webviewDetachSurface(attached);
        [attached removeFromSuperview];
        [attached release];
        sp_surface_close(surface);
        [window close];
        [[window retain] autorelease];
        [window release];
        sp_window_objects pending = sp_window_objects_count();
        check(pending.windowCompositions == expected.windowCompositions, [NSString stringWithFormat:
            @"an autoreleased window keeps its composition until its event iteration ends (%@)", describe(pending)]);
        sp_window_objects_when(&baseline, 10, counted, &state);
        NSEvent *event;
        do {
            event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:10]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (!event) break;
            [NSApp sendEvent:event];
        } while (event.type != NSEventTypeApplicationDefined || event.subtype == 0);
        check(event != nil, @"the posted event is delivered within 10 seconds");
        check(state.calls == 0, @"the counts are not read in the iteration that handles the posted event");
    }
    handleEventsUntilCounted(&state);
    check(state.calls == 1 && state.mainThread, [NSString stringWithFormat:
        @"the counts are given once on the main thread after the posted event (calls %d)", state.calls]);
    check(state.reached && same(state.counts, baseline), [NSString stringWithFormat:
        @"the closed window and its webviews return the counts to %@ (reached %d, counts %@)",
        describe(baseline), state.reached, describe(state.counts)]);

    SPCounted now = {0};
    sp_window_objects_when(NULL, 10, counted, &now);
    handleEventsUntilCounted(&now);
    check(now.calls == 1 && now.reached && same(now.counts, baseline), [NSString stringWithFormat:
        @"without expected counts the counts after the posted event are given (calls %d, reached %d, counts %@)",
        now.calls, now.reached, describe(now.counts)]);

    SPCounted missed = {0};
    sp_window_objects unreachable = {baseline.windowCompositions + 1, baseline.surfaceHosts, baseline.inputRegistrations};
    sp_window_objects_when(&unreachable, 0.2, counted, &missed);
    handleEventsUntilCounted(&missed);
    check(missed.calls == 1 && !missed.reached && same(missed.counts, baseline), [NSString stringWithFormat:
        @"counts that do not reach the expected counts within the bound are given as not reached (calls %d, reached %d, counts %@)",
        missed.calls, missed.reached, describe(missed.counts)]);
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
