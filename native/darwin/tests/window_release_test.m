// 닫은 창과 그 웹뷰, 공용 라이브러리가 창과 웹뷰에 붙인 네이티브 객체가 모두 해제되는지 검사한다.
// 호스트가 프로젝트 창에 하는 순서대로 메인 웹뷰 등록, 첫 화면 표시 대기, 입력 등록, 파일 놓기, 가림 관찰,
// 논리 표면, 붙인 표면 웹뷰, 모달 웹뷰, 문서 영역, 그림 영역, 배치 트랜잭션과 표시 대기를 붙인다. 그 뒤
// 호스트가 소유한 핸들(그림 영역, 문서 영역, 붙인 표면 웹뷰, 논리 표면)만 라이브러리의 닫기 함수로 닫는다.
// 메인 웹뷰와 모달 웹뷰는 창을 만든 프레임워크가 하는 것처럼 뷰 계층에서 빼고 놓기만 하며 입력 등록을
// 해제하지 않는다. 해제되지 않은 웹뷰는 웹 콘텐츠 프로세스를 끝내지 않는다.
// 애플리케이션을 활성화하지 않는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "document_view.h"
#import "image_region.h"
#import "surface_layout.h"
#import "webview_geometry.h"
#import "webview_input.h"
#import "window_facts.h"
#import "window_reveal.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// 수동 참조 계수에서는 __weak 를 쓸 수 없으므로 런타임의 약한 참조 칸을 쓴다. 칸은 객체가 해제되면 nil 이 된다.
enum { kTracked = 32 };
static id weakSlots[kTracked];
static const char *weakNames[kTracked];
static int trackedCount;

static void track(const char *name, id object) {
    if (!object) { check(NO, [NSString stringWithFormat:@"%s exists before the window closes", name]); return; }
    weakNames[trackedCount] = name;
    objc_storeWeak(&weakSlots[trackedCount], object);
    trackedCount++;
}

// objc_loadWeak 는 객체를 자동 해제 풀에 넣어 수명을 늘리므로 읽기마다 풀을 비운다.
static BOOL released(int index) {
    BOOL alive;
    @autoreleasepool { alive = objc_loadWeak(&weakSlots[index]) != nil; }
    return !alive;
}

static BOOL allReleased(void) {
    for (int i = 0; i < trackedCount; i++) {
        if (!released(i)) return NO;
    }
    return YES;
}

static NSView *subviewOfClass(NSView *parent, NSString *name) {
    for (NSView *child in parent.subviews) {
        if ([NSStringFromClass(child.class) isEqualToString:name]) return child;
    }
    return nil;
}

@interface SPNavigation : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end

@implementation SPNavigation
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { self.finished = YES; }
@end

static void documentChanged(void *context, const char *state) {}
static void regionEvent(void *context, const char *json) {}
static void fileDropped(void *context, const char *json) {}

// 놓기 뷰가 놓은 수신기. 호스트는 여기서 수신기를 해제한다.
static NSMutableArray<NSString *> *releasedReceivers;
static void fileDropReleased(void *context) { [releasedReceivers addObject:(NSString *)context]; }

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSString *store = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"window-release-test-%d", getpid()]];

    NSWindow *window;
    void *surface;
    void *document;
    void *region;
    WKWebView *attached;
    @autoreleasepool {
        window = [[NSWindow alloc] initWithContentRect:NSMakeRect(60, 60, 600, 400)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        [window.contentView addSubview:main];
        SPNavigation *navigation = [[SPNavigation new] autorelease];
        main.navigationDelegate = navigation;
        check(sp_window_set_main_webview(window, main), @"the main webview is registered");
        char *error = NULL;
        check(sp_window_reveal_after_load(window, &error), @"the window waits for the first page");
        free(error);
        check(webviewInputRegister(main), @"the main webview registers for input");
        [main loadHTMLString:@"<!doctype html><body>main</body>" baseURL:nil];
        [window orderFrontRegardless];
        until(@"the main page did not load", ^BOOL { return navigation.finished; });
        until(@"the window was not revealed after the first page", ^BOOL { return window.alphaValue == 1; });
        releasedReceivers = [[NSMutableArray alloc] init];
        check(sp_window_file_drop(main, fileDropped, fileDropReleased, @"first"), @"the window receives file drops");
        check(sp_window_file_drop(main, fileDropped, fileDropReleased, @"second"), @"the window replaces its file drop receiver");
        check([releasedReceivers isEqualToArray:@[@"first"]],
            [NSString stringWithFormat:@"a replaced file drop receiver is released once (released %@)", releasedReceivers]);
        // 가림 관찰의 블록이 잡은 객체는 관찰이 끝나야 해제된다.
        NSObject *occlusionCapture = [[NSObject new] autorelease];
        check(sp_window_observe_occlusion(window, ^{ [occlusionCapture self]; }), @"the window occlusion is observed");

        surface = sp_surface_create(main);
        check(surface != NULL, @"a logical surface is created");
        webviewSetFrame(surface, 10, 10, 400, 300);
        webviewSetSurfaceHidden(surface, false);
        document = sp_document_create(surface, store.fileSystemRepresentation, documentChanged, NULL);
        check(document != NULL, @"a document region is created");
        sp_document_place(document, 10, 10, 10, 10, true);
        region = sp_region_create(surface, "region", regionEvent, NULL);
        check(region != NULL, @"an image region is created");
        sp_region_place(region, 20, 20, 20, 20, true);

        attached = [[WKWebView alloc] initWithFrame:NSMakeRect(20, 20, 200, 120)];
        [window.contentView addSubview:attached positioned:NSWindowAbove relativeTo:nil];
        check(webviewInputRegister(attached) && webviewIgnorePageFocus(attached), @"an attached surface webview registers for input");
        webviewAttachSurface(attached, main);
        // 모달처럼 창을 채우는 웹뷰. 입력은 등록하지만 표면에 붙이지 않는다.
        WKWebView *modal = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 600, 400)] autorelease];
        [window.contentView addSubview:modal positioned:NSWindowAbove relativeTo:nil];
        check(webviewInputRegister(modal) && webviewIgnorePageFocus(modal), @"a modal webview registers for input");

        __block BOOL ready = NO;
        surfaceLayoutBegin(window, 1, ^(int allowed) { ready = allowed != 0; });
        check(ready, @"the layout transaction opens");
        check(surfaceLayoutCommit(window, 1), @"the layout transaction commits");
        __block BOOL settled = NO;
        surfaceLayoutAfterSettled(main, ^(double displayed, const char *failure) { settled = YES; });
        until(@"the main page did not settle", ^BOOL { return settled; });

        NSView *composition = main.superview;
        NSView *coordinates = subviewOfClass(composition, @"SPSurfaceCoordinates");
        track("NSWindow", window);
        track("main WKWebView", main);
        track("main WKUserContentController", main.configuration.userContentController);
        track("SPWindowComposition", composition);
        track("SPSurfaceCoordinates", coordinates);
        track("SPFileDropView", subviewOfClass(composition, @"SPFileDropView"));
        track("occlusion observation block capture", occlusionCapture);
        track("logical SPSurfaceHost", (id)surface);
        track("logical SPSurfaceNativePlane", (id)sp_surface_native_plane(surface));
        track("SPDocumentView", (id)document);
        track("document WKUserContentController", ((WKWebView *)document).configuration.userContentController);
        track("SPImageRegion", (id)region);
        track("attached surface WKWebView", attached);
        track("attached surface WKUserContentController", attached.configuration.userContentController);
        track("attached SPSurfaceHost", attached.superview);
        track("attached SPSurfaceNativePlane", (id)webviewSurfaceNativePlane(attached));
        track("modal WKWebView", modal);
        track("modal WKUserContentController", modal.configuration.userContentController);
        [modal removeFromSuperview];
    }

    // 호스트가 창을 닫을 때 하는 정리: 영역과 문서, 붙인 웹뷰, 표면을 닫고 배치를 취소한 뒤 창을 닫는다.
    @autoreleasepool {
        sp_region_close(region);
        sp_document_close(document);
        webviewInputUnregister(attached);
        webviewDetachSurface(attached);
        [attached removeFromSuperview];
        [attached release];
        sp_surface_close(surface);
        surfaceLayoutCancel(window);
        [window close];
        [window release];
    }
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!allReleased() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
    }
    check([releasedReceivers isEqualToArray:@[@"first", @"second"]],
        [NSString stringWithFormat:@"the closed window releases its file drop receiver once (released %@)", releasedReceivers]);
    for (int i = 0; i < trackedCount; i++) {
        check(released(i), [NSString stringWithFormat:@"the closed window releases its %s", weakNames[i]]);
    }
    [NSFileManager.defaultManager removeItemAtPath:store error:NULL];
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
