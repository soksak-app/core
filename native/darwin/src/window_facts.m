// 호스트가 공개하는 창 상태(host.window, host.screens, host.dock)의 네이티브 값을 읽는다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "window_facts.h"

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

char *sp_window_facts(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    if (!window || !window.contentView) return NULL;
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
    NSMutableArray *webviews = [NSMutableArray array];
    for (WKWebView *view in views) {
        NSRect rect = [view convertRect:view.bounds toView:nil];
        NSMutableDictionary *row = [windowRect(window, rect) mutableCopy];
        row[@"view"] = @((unsigned long long)(uintptr_t)view);
        row[@"hidden"] = @(view.isHiddenOrHasHiddenAncestor);
        // drawsBackground 는 비공개 KVC 키다. docs/operations/private-native-apis.md 참고.
        row[@"draws"] = [view valueForKey:@"drawsBackground"];
        row[@"alpha"] = @(view.underPageBackgroundColor.alphaComponent);
        [webviews addObject:row];
        [row release];
    }
    return copyJSON(@{
        @"frame": screenRect(window.frame),
        @"content": @{ @"width": @(content.bounds.size.width), @"height": @(content.bounds.size.height) },
        @"scale": @(window.backingScaleFactor),
        @"key": @(window.isKeyWindow),
        @"zoomed": @(window.isZoomed),
        @"active": @(NSApp.isActive),
        @"children": @(window.childWindows.count),
        @"controls": controls,
        @"webviews": webviews,
    });
}

char *sp_window_hit(void *handle, double x, double y) {
    NSWindow *window = (NSWindow *)handle;
    NSView *content = window.contentView;
    if (!window || !content) return NULL;
    NSPoint base = NSMakePoint(x, content.frame.size.height - y);
    NSView *hit = [content hitTest:[content.superview convertPoint:base fromView:nil]];
    NSView *owner = hit;
    while (owner && ![owner isKindOfClass:WKWebView.class]) owner = owner.superview;
    NSMutableArray<WKWebView *> *views = [NSMutableArray array];
    collectWebViews(content, views);
    return copyJSON(@{ @"view": @((unsigned long long)(uintptr_t)owner), @"main": owner && owner == views.firstObject ? @YES : @NO,
        @"identifier": hit.identifier ?: @"" });
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
