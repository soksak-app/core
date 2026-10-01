// 호스트가 공개하는 창 상태(host.window, host.screens, host.dock)의 네이티브 값을 읽는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "window_facts.h"
#import "webview_geometry.h"
#import "private/webkit.h"
#import "surface_layout.h"

static const char mainWebviewKey;

bool sp_window_set_main_webview(void *handle, void *mainHandle) {
    NSCAssert(NSThread.isMainThread, @"window registration requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    WKWebView *main = (WKWebView *)mainHandle;
    if (!window || ![main isKindOfClass:WKWebView.class] || main.window != window) return false;
    NSValue *registered = objc_getAssociatedObject(window, &mainWebviewKey);
    if (registered && registered.nonretainedObjectValue != main) return false;
    // 배치 표시는 이 웹뷰의 다음 표시를 기다리므로 이 웹뷰는 화면 갱신 주기로 렌더링해야 한다.
    if (!registered && !surfaceLayoutRenderAtDisplayRate(main)) return false;
    // 같은 이유로 창이 가려져도 문서를 숨기지 않는다. WebKit 은 가려진 창의 문서를 숨기고 animation frame 을
    // 멈추므로, 가려진 창의 배치 표시와 그 표시를 기다리는 명령이 끝나지 않는다.
    if (![main respondsToSelector:@selector(_setWindowOcclusionDetectionEnabled:)]) return false;
    main._windowOcclusionDetectionEnabled = NO;
    objc_setAssociatedObject(window, &mainWebviewKey, [NSValue valueWithNonretainedObject:main], OBJC_ASSOCIATION_RETAIN);
    return true;
}

void *sp_window_main_webview(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    NSValue *registered = objc_getAssociatedObject(window, &mainWebviewKey);
    return registered.nonretainedObjectValue;
}

static WKWebView *mainWebview(NSWindow *window) { return sp_window_main_webview(window); }

static BOOL webviewFocused(NSView *view) {
    NSResponder *responder = view.window.firstResponder;
    if (responder == view) return YES;
    return [responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:view];
}

static char *copyJSON(id value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (!data) return NULL;
    char *text = malloc(data.length + 1);
    memcpy(text, data.bytes, data.length);
    text[data.length] = 0;
    return text;
}

void sp_facts_free(char *text) { free(text); }

static CGFloat primaryTop(void) { return NSMaxY(NSScreen.screens.firstObject.frame); }

static NSDictionary *screenRect(NSRect rect) {
    return @{ @"x": @(rect.origin.x), @"y": @(primaryTop() - NSMaxY(rect)),
        @"width": @(rect.size.width), @"height": @(rect.size.height) };
}

// 창 기준 좌표(왼쪽 아래 원점)의 사각형을 콘텐츠 영역 왼쪽 위 기준으로 바꾼다. 콘텐츠 뷰는
// 창 기준 좌표의 원점에 있다.
static NSDictionary *windowRect(NSWindow *window, NSRect base) {
    CGFloat height = window.contentView.frame.size.height;
    return @{ @"x": @(base.origin.x), @"y": @(height - NSMaxY(base)),
        @"width": @(base.size.width), @"height": @(base.size.height) };
}

static void collectWebViews(NSView *view, NSMutableArray<WKWebView *> *found) {
    // 부모가 자식보다 먼저 그려지고, 같은 부모의 하위 뷰는 뒤의 것이 위에 그려진다.
    if ([view isKindOfClass:WKWebView.class]) [found addObject:(WKWebView *)view];
    for (NSView *child in view.subviews) collectWebViews(child, found);
}

static void collectSurfaces(NSWindow *window, NSView *view, NSMutableArray *found) {
    NSView *plane = sp_surface_native_plane(view);
    if (plane && plane.superview == view) {
        NSMutableDictionary *row = [windowRect(window, [view convertRect:view.bounds toView:nil]) mutableCopy];
        row[@"view"] = @((unsigned long long)(uintptr_t)view);
        row[@"hidden"] = @(view.isHiddenOrHasHiddenAncestor);
        [found addObject:row];
        [row release];
    }
    for (NSView *child in view.subviews) collectSurfaces(window, child, found);
}

char *sp_window_facts(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    if (!window || !window.contentView || !mainWebview(window)) return NULL;
    NSView *content = window.contentView;
    NSMutableArray *controls = [NSMutableArray array];
    for (NSUInteger kind = NSWindowCloseButton; kind <= NSWindowZoomButton; kind++) {
        NSButton *button = [window standardWindowButton:kind];
        if (!button) continue;
        NSRect rect = [button convertRect:[button alignmentRectForFrame:button.bounds] toView:nil];
        NSMutableDictionary *row = [windowRect(window, rect) mutableCopy];
        row[@"hidden"] = @(button.isHiddenOrHasHiddenAncestor);
        [controls addObject:row];
        [row release];
    }
    NSMutableArray<WKWebView *> *views = [NSMutableArray array];
    collectWebViews(content, views);
    NSMutableArray *surfaces = [NSMutableArray array];
    collectSurfaces(window, content, surfaces);
    NSMutableArray *webviews = [NSMutableArray array];
    NSUInteger documents = 0;
    for (WKWebView *view in views) {
        NSRect rect = [view convertRect:view.bounds toView:nil];
        NSMutableDictionary *row = [windowRect(window, rect) mutableCopy];
        row[@"view"] = @((unsigned long long)(uintptr_t)view);
        row[@"hidden"] = @(view.isHiddenOrHasHiddenAncestor);
        row[@"focused"] = @(webviewFocused(view));
        // drawsBackground 는 비공개 KVC 키다. docs/operations/private-native-apis.md 참고.
        row[@"draws"] = [view valueForKey:@"drawsBackground"];
        row[@"alpha"] = @(view.underPageBackgroundColor.alphaComponent);
        row[@"main"] = @((BOOL)(view == mainWebview(window)));
        int near60 = surfaceLayoutPrefersNear60FPS(view);
        row[@"near60fps"] = near60 < 0 ? (id)NSNull.null : @(near60 == 1);
        NSView *nativePlane = (NSView *)sp_surface_native_plane(view);
        BOOL document = view != mainWebview(window) && nativePlane && [view isDescendantOf:nativePlane];
        row[@"document"] = @(document);
        if (document) documents++;
        [webviews addObject:row];
        [row release];
    }
    // 첫 응답자와 그것을 담은 웹뷰. 키보드 입력이 어디로 가는지 보고한다.
    // surface 는 첫 응답자를 담은 표면 뷰이며 nativeSurfaces 의 view 와 같은 기준이다.
    NSResponder *first = window.firstResponder;
    NSView *owner = [first isKindOfClass:NSView.class] ? (NSView *)first : nil;
    while (owner && ![owner isKindOfClass:WKWebView.class]) owner = owner.superview;
    NSView *surface = [first isKindOfClass:NSView.class] ? (NSView *)first : nil;
    while (surface) {
        NSView *plane = sp_surface_native_plane(surface);
        if (plane && plane.superview == surface) break;
        surface = surface.superview;
    }
    NSDictionary *responder = @{
        @"class": first ? NSStringFromClass(first.class) : @"",
        @"webview": @((unsigned long long)(uintptr_t)owner),
        @"surface": @((unsigned long long)(uintptr_t)surface),
        @"main": owner != nil && owner == mainWebview(window) ? @YES : @NO,
    };
    return copyJSON(@{
        @"responder": responder,
        @"frame": screenRect(window.frame),
        @"pointer": @{ @"x": @(NSEvent.mouseLocation.x), @"y": @(primaryTop() - NSEvent.mouseLocation.y) },
        @"content": @{ @"width": @(content.bounds.size.width), @"height": @(content.bounds.size.height) },
        @"scale": @(window.backingScaleFactor),
        @"key": @(window.isKeyWindow),
        @"zoomed": @(window.isZoomed),
        @"active": @(NSApp.isActive),
        // 다른 창에 완전히 가려진 창은 WebKit 이 그리기를 늦추므로 표시 측정의 조건이다.
        @"occluded": @((BOOL)((window.occlusionState & NSWindowOcclusionStateVisible) == 0)),
        @"children": @(window.childWindows.count),
        @"controls": controls,
        @"webviews": webviews,
        @"nativeSurfaces": surfaces,
        @"appDomWebviews": @(views.count - documents),
        @"documentWebviews": @(documents),
    });
}

char *sp_window_hit(void *handle, double x, double y) {
    NSWindow *window = (NSWindow *)handle;
    NSView *content = window.contentView;
    if (!window || !content || !mainWebview(window)) return NULL;
    NSPoint base = NSMakePoint(x, content.frame.size.height - y);
    NSView *hit = [content hitTest:[content.superview convertPoint:base fromView:nil]];
    NSView *owner = hit;
    while (owner && ![owner isKindOfClass:WKWebView.class]) owner = owner.superview;
    id hitFacts = NSNull.null;
    if (hit) {
        hitFacts = @{
            @"class": NSStringFromClass(hit.class),
            @"frame": windowRect(window, [hit convertRect:hit.bounds toView:nil]),
        };
    }
    return copyJSON(@{ @"view": @((unsigned long long)(uintptr_t)owner), @"main": owner && owner == mainWebview(window) ? @YES : @NO,
        @"identifier": hit.identifier ?: @"", @"hit": hitFacts });
}

char *sp_screens(void) {
    NSMutableArray *screens = [NSMutableArray array];
    for (NSScreen *screen in NSScreen.screens) {
        NSMutableDictionary *row = [screenRect(screen.frame) mutableCopy];
        row[@"scale"] = @(screen.backingScaleFactor);
        row[@"visible"] = screenRect(screen.visibleFrame);
        [screens addObject:row];
        [row release];
    }
    return copyJSON(screens);
}

bool sp_window_move(void *handle, double x, double y) {
    NSWindow *window = (NSWindow *)handle;
    if (!window) return false;
    [window setFrameOrigin:NSMakePoint(x, primaryTop() - y - window.frame.size.height)];
    return true;
}

static NSMenu *dockMenu(void) {
    id<NSApplicationDelegate> delegate = NSApp.delegate;
    return [delegate respondsToSelector:@selector(applicationDockMenu:)] ? [delegate applicationDockMenu:NSApp] : nil;
}

// 메뉴 항목의 단축키. 단축키가 없으면 빈 문자열이다.
static NSString *menuKey(NSMenuItem *item) {
    if (item.keyEquivalent.length == 0) return @"";
    NSEventModifierFlags mask = item.keyEquivalentModifierMask;
    NSMutableString *key = [NSMutableString string];
    if (mask & NSEventModifierFlagControl) [key appendString:@"ctrl+"];
    if (mask & NSEventModifierFlagOption) [key appendString:@"opt+"];
    if (mask & NSEventModifierFlagShift) [key appendString:@"shift+"];
    if (mask & NSEventModifierFlagCommand) [key appendString:@"cmd+"];
    [key appendString:item.keyEquivalent];
    return key;
}

// 시스템 선호 언어의 주 태그(예: "ko", "ja"). 어떤 언어가 지원되는지는 호출자의 표가 정하고
// 표에 없으면 호출자가 기본 언어를 쓴다. 반환값은 sp_facts_free 로 해제한다. 페이지가 설정 언어를
// 보내기 전의 초기 메뉴가 시스템 언어를 따르게 한다(docs/spec/host-contract.md 의 Application menu).
char *sp_preferred_language(void) {
    NSArray<NSString *> *languages = [[NSUserDefaults standardUserDefaults] stringArrayForKey:@"AppleLanguages"];
    NSString *first = languages.firstObject ?: NSLocale.preferredLanguages.firstObject;
    NSString *tag = [[first componentsSeparatedByString:@"-"] firstObject].lowercaseString;
    const char *utf8 = tag.UTF8String ?: "en";
    char *copy = strdup(utf8);
    return copy;
}

char *sp_menu_items(void) {
    NSMutableArray *menus = [NSMutableArray array];
    for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
        NSMutableArray *items = [NSMutableArray array];
        // AppKit 은 메뉴를 처음 열 때야 시스템 항목(예: 전체 화면 시작)을 늦게 넣는다.
        // 열기 전의 항목 배열은 불완전하므로 update 로 확정한 뒤 읽는다.
        [top.submenu update];
        for (NSMenuItem *item in top.submenu.itemArray) {
            if (item.isSeparatorItem) continue;
            [items addObject:@{ @"title": item.title, @"key": menuKey(item) }];
        }
        NSString *title = top.submenu.title.length ? top.submenu.title : top.title;
        [menus addObject:@{ @"title": title, @"items": items }];
    }
    return copyJSON(menus);
}

bool sp_menu_select(const char *menu, const char *title) {
    if (!menu || !title) return false;
    NSString *menuTitle = [NSString stringWithUTF8String:menu];
    NSString *itemTitle = [NSString stringWithUTF8String:title];
    for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
        NSString *name = top.submenu.title.length ? top.submenu.title : top.title;
        if (![name isEqualToString:menuTitle]) continue;
        NSInteger index = [top.submenu indexOfItemWithTitle:itemTitle];
        if (index < 0) return false;
        NSMenuItem *item = [top.submenu itemAtIndex:index];
        if (!item.action) return false;
        // performActionForItemAtIndex: 는 이 시스템에서 행위를 실행 루프로 미루므로(V5-108)
        // 동등한 동기 형식으로 항목을 고른다. 대상이 없으면 응답자 사슬을 지나며, 전달
        // 여부를 그대로 돌려준다.
        return [NSApp sendAction:item.action to:item.target from:item];
    }
    return false;
}

void *sp_app_main_window(void) {
    if (NSApp.mainWindow) return NSApp.mainWindow;
    // 한 번도 활성화되지 않은 애플리케이션에는 주 창이 없다. 그때는 가장 앞의 보이는 창이다.
    for (NSWindow *window in NSApp.orderedWindows) {
        if (window.isVisible && window.canBecomeMainWindow) return window;
    }
    return NULL;
}

char *sp_dock_items(void) {
    NSMutableArray *titles = [NSMutableArray array];
    for (NSMenuItem *item in dockMenu().itemArray) [titles addObject:item.title];
    return copyJSON(titles);
}

bool sp_dock_select(const char *title) {
    NSMenu *menu = dockMenu();
    NSInteger index = menu && title ? [menu indexOfItemWithTitle:[NSString stringWithUTF8String:title]] : -1;
    if (index < 0) return false;
    [menu performActionForItemAtIndex:index];
    return true;
}

// 창 하나의 가림 상태 관찰. 창의 연결 객체로 두어 창과 함께 해제되며 그때 관찰을 끝낸다.
@interface SPOcclusionObserver : NSObject
@property(nonatomic, retain) id token;
@end

@implementation SPOcclusionObserver
- (void)dealloc {
    if (_token) [NSNotificationCenter.defaultCenter removeObserver:_token];
    [_token release];
    [super dealloc];
}
@end

static const char occlusionObserverKey;

bool sp_window_observe_occlusion(void *handle, void (^changed)(void)) {
    NSCAssert(NSThread.isMainThread, @"occlusion observation requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    if (!window || !changed) return false;
    void (^callback)(void) = [[changed copy] autorelease];
    SPOcclusionObserver *observer = [[SPOcclusionObserver new] autorelease];
    observer.token = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification
        object:window queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) { callback(); }];
    objc_setAssociatedObject(window, &occlusionObserverKey, observer, OBJC_ASSOCIATION_RETAIN);
    return true;
}
